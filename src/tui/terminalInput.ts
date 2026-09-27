import { useEffect, useRef } from "react";
import { useInput, useStdin, type Key } from "ink";

const ESC = "\x1b";
const BEL = "\x07";

export interface SgrMouseReport {
  code: number;
  x: number;
  y: number;
  final: "M" | "m";
  action: "press" | "release" | "scroll" | "move";
}

interface TerminalInputChunk {
  text: string;
  mouse: SgrMouseReport[];
  paste: boolean;
  continuation: boolean;
}

// Ink 5 removes ESC prefixes and Home/End names before useInput runs. Capture
// the same input event first so consumers can also inspect its original bytes.
export function useTerminalInput(handler: (input: string, key: Key, raw: string) => void) {
  const { internal_eventEmitter } = useStdin();
  const raw = useRef("");
  useEffect(() => {
    const capture = (data: string) => { raw.current = String(data); };
    internal_eventEmitter.prependListener("input", capture);
    return () => { internal_eventEmitter.removeListener("input", capture); };
  }, [internal_eventEmitter]);
  useInput((input, key) => handler(input, key, raw.current));
}

export function createTerminalControlInputStripper() {
  let mode: "text" | "escape" | "csi" | "osc" | "string" | "string-escape" | "ss3" | "x10" = "text";
  let control = "";
  let bare = false;
  let stringMode: "osc" | "string" = "osc";
  let remainingMouseBytes = 0;
  let inPaste = false;
  let previousCR = false;

  const read = (value: string): TerminalInputChunk => {
    const continuedEscape = mode === "escape";
    const result: TerminalInputChunk = { text: "", mouse: [], paste: inPaste, continuation: mode !== "text" };
    const append = (char: string) => {
      if (char === "\n" && previousCR) {
        previousCR = false;
        return;
      }
      previousCR = char === "\r";
      if (previousCR) result.text += "\n";
      else {
        const code = char.charCodeAt(0);
        if (char === "\n" || char === "\t" || (code >= 32 && (code < 127 || code > 159))) result.text += char;
      }
    };

    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (mode === "x10") {
        if (--remainingMouseBytes === 0) mode = "text";
        continue;
      }
      if (mode === "osc" || mode === "string") {
        if (char === BEL && mode === "osc") mode = "text";
        else if (char === ESC) {
          stringMode = mode;
          mode = "string-escape";
        }
        continue;
      }
      if (mode === "string-escape") {
        mode = char === "\\" || (char === BEL && stringMode === "osc") ? "text" : char === ESC ? "string-escape" : stringMode;
        continue;
      }
      if (mode === "escape") {
        mode = "text";
        if (char === "[") { mode = "csi"; control = ""; bare = false; }
        else if (char === "]") mode = "osc";
        else if (char === "P" || char === "^" || char === "_") mode = "string";
        else if (char === "O") mode = "ss3";
        else if (char === ESC) mode = "escape";
        else if (continuedEscape && index === 0) {
          result.continuation = false;
          index--;
        }
        continue;
      }
      if (mode === "ss3") {
        mode = char === ESC ? "escape" : "text";
        continue;
      }
      if (mode === "csi") {
        if (char === ESC) { mode = "escape"; continue; }
        // An interrupted mouse report must not consume unrelated digits later.
        if (control.startsWith("<") && !/[\d;mM]/.test(char)) {
          mode = "text";
          index--;
          continue;
        }
        if (/[\x40-\x7e]/.test(char)) {
          mode = "text";
          const sequence = `[${control}${char}`;
          if (control === "" && char === "M" && !bare) {
            mode = "x10";
            remainingMouseBytes = 3;
          } else if (sequence === "[200~" || sequence === "[201~") {
            inPaste = sequence === "[200~";
            result.paste = true;
          } else {
            const mouse = parseSgrMouse(sequence);
            if (mouse) result.mouse.push(mouse);
            else if (bare && !control.startsWith("<")) for (const literal of sequence) append(literal);
          }
        } else if (/[\x20-\x3f]/.test(char)) {
          // Bound buffering even for an unterminated or malicious CSI stream.
          if (control.length < 128) control += char;
        } else {
          mode = "text";
          index--;
        }
        continue;
      }
      if (char === ESC) {
        mode = "escape";
      } else if (char === "[" && /^(?:<|20)/.test(value.slice(index + 1))) {
        // Compatibility for callers still using Ink's ESC-stripped input.
        // A lone '[' remains ordinary text rather than delaying normal typing.
        mode = "csi";
        control = "";
        bare = true;
      } else {
        append(char);
      }
    }
    return result;
  };

  return { read, strip: (value: string) => read(value).text };
}

const defaultStripper = createTerminalControlInputStripper();

export function stripTerminalControlInput(value: string): string {
  return defaultStripper.strip(value);
}

export function parseSgrMouse(input: string): SgrMouseReport | null {
  const parts = new RegExp(`${ESC}?\\[<(\\d+);(\\d+);(\\d+)([mM])`).exec(input);
  if (!parts) return null;
  const code = Number(parts[1]);
  const x = Number(parts[2]);
  const y = Number(parts[3]);
  if (![code, x, y].every(Number.isSafeInteger) || code > 255 || x < 1 || y < 1) return null;
  const final = parts[4] as "M" | "m";
  return {
    code, x, y, final,
    action: final === "m" ? "release" : (code & 64) ? "scroll" : (code & 32) ? "move" : "press",
  };
}
