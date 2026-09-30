import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { useEffect, useMemo, useRef } from "react";
import { useStdin, type Key } from "ink";

interface InkKeypress {
  name?: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option: boolean;
  sequence: string;
  code?: string;
}

// Ink 5 does not export its parser or batching API. Resolve them next to its
// installed entry rather than copy its key table or patch node_modules. The
// parity and built-runtime tests cover this deliberately version-specific adapter.
const inkEntry = pathToFileURL(createRequire(import.meta.url).resolve("ink"));
const { default: parseKeypress, nonAlphanumericKeys } = await import(new URL("./parse-keypress.js", inkEntry).href) as {
  default: (raw: string) => InkKeypress;
  nonAlphanumericKeys: string[];
};
const { default: reconciler } = await import(new URL("./reconciler.js", inkEntry).href) as {
  default: { batchedUpdates: (callback: () => void) => void };
};

interface InputOptions { isActive?: boolean }

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
  continuedEscape: boolean;
  events: TerminalInputEvent[];
}

export type TerminalInputKey =
  | "start" | "end" | "left" | "right" | "up" | "down"
  | "clear-before" | "clear-after" | "word-left" | "word-right"
  | "delete-backward" | "delete-forward" | "delete-word-before" | "delete-word-after"
  | "enter" | "steer";

type TerminalInputEvent =
  | { type: "text"; text: string; paste: boolean }
  | { type: "key"; key: TerminalInputKey };

// Editing needs the whole byte stream, not Ink's single-key interpretation of
// each read (which also throws for some otherwise valid CSI-u sequences).
export function useRawTerminalInput(handler: (raw: string) => void, { isActive = true }: InputOptions = {}) {
  const { internal_eventEmitter, setRawMode } = useStdin();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!isActive) return;
    const handle = (data: string) => reconciler.batchedUpdates(() => handlerRef.current(String(data)));
    setRawMode(true);
    internal_eventEmitter.on("input", handle);
    return () => {
      internal_eventEmitter.removeListener("input", handle);
      setRawMode(false);
    };
  }, [internal_eventEmitter, setRawMode, isActive]);
}

// Drop-in useInput replacement, with the original bytes as an extra argument.
// Raw-aware consumers must receive every read so they can drain split controls.
export function useTerminalInput(handler: (input: string, key: Key, raw: string) => void, options: InputOptions = {}) {
  const { internal_exitOnCtrlC } = useStdin();
  const active = options.isActive !== false;
  const stripper = useMemo(() => createTerminalControlInputStripper(), [active]);
  useRawTerminalInput((raw) => {
    const chunk = stripper.read(raw);
    let keypress = parseKeypress(raw);
    let input: string;
    const suppressed = chunk.paste || (chunk.continuation && !(chunk.continuedEscape && raw.startsWith(ESC)));
    const backspace = raw.startsWith(ESC) ? /^\[(?:8|127)(?:;(\d+)(?::([123]))?)?u$/.exec(raw.slice(1)) : null;
    const modifiers = Number(backspace?.[1] ?? 1);
    if (!suppressed && backspace && modifiers >= 1 && modifiers <= 256 && backspace[2] !== "3") {
      const bits = modifiers - 1;
      keypress = { name: "backspace", sequence: "", ctrl: Boolean(bits & 4), meta: Boolean(bits & (2 | 8 | 32)), shift: Boolean(bits & 1), option: false };
    }
    // Unknown CSI keys can have ctrl=true but name=undefined in Ink. Never
    // convert those into text or application shortcuts. Filter split OSC/paste
    // payloads too, while preserving the original mouse bytes for legacy callers.
    if (suppressed || keypress.name === undefined ||
      (raw.includes(ESC) && !keypress.name && !keypress.meta && !chunk.mouse.length)) {
      keypress = { name: "", sequence: "", ctrl: false, meta: false, shift: false, option: false };
      input = chunk.text;
    } else {
      input = keypress.ctrl ? keypress.name || "" : keypress.sequence;
      if (nonAlphanumericKeys.includes(keypress.name || "")) input = "";
      if (input.startsWith(ESC)) input = input.slice(1);
    }
    const key: Key = {
      upArrow: keypress.name === "up", downArrow: keypress.name === "down",
      leftArrow: keypress.name === "left", rightArrow: keypress.name === "right",
      pageDown: keypress.name === "pagedown", pageUp: keypress.name === "pageup",
      return: keypress.name === "return", escape: keypress.name === "escape",
      ctrl: keypress.ctrl, shift: keypress.shift || (input.length === 1 && /[A-Z]/.test(input)),
      tab: keypress.name === "tab", backspace: keypress.name === "backspace", delete: keypress.name === "delete",
      meta: keypress.meta || keypress.name === "escape" || keypress.option,
    };
    if (!(input === "c" && key.ctrl && internal_exitOnCtrlC)) handler(input, key, raw);
  }, options);
}

export const useSafeInput = useTerminalInput;

export function createTerminalControlInputStripper() {
  let mode: "text" | "escape" | "csi" | "osc" | "string" | "string-escape" | "ss3" | "x10" = "text";
  let control = "";
  let overflow = false;
  let bare = false;
  let stringMode: "osc" | "string" = "osc";
  let remainingMouseBytes = 0;
  let inPaste = false;
  let previousCR = false;

  const read = (value: string): TerminalInputChunk => {
    const continuedEscape = mode === "escape";
    const result: TerminalInputChunk = { text: "", mouse: [], paste: inPaste, continuation: mode !== "text", continuedEscape, events: [] };
    const emitKey = (key: TerminalInputKey | null) => {
      if (key && !inPaste) result.events.push({ type: "key", key });
    };
    const emitText = (text: string) => {
      const previous = result.events[result.events.length - 1];
      if (previous?.type === "text" && previous.paste === inPaste) previous.text += text;
      else result.events.push({ type: "text", text, paste: inPaste });
    };
    const append = (char: string) => {
      if (char === "\n" && previousCR) {
        previousCR = false;
        return;
      }
      previousCR = char === "\r";
      if (previousCR || char === "\n") {
        result.text += "\n";
        if (inPaste) emitText("\n");
        else emitKey("enter");
        return;
      }
      const code = char.charCodeAt(0);
      if (char === "\t" || (code >= 32 && (code < 127 || code > 159))) {
        result.text += char;
        emitText(char);
      } else {
        emitKey(controlKey(code));
      }
    };

    for (let index = 0; index < value.length; index++) {
      const char = value[index];
      if (char !== "\n") previousCR = false;
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
        if (char === "[") { mode = "csi"; control = ""; bare = false; overflow = false; }
        else if (char === "]") mode = "osc";
        else if (char === "P" || char === "^" || char === "_") mode = "string";
        else if (char === "O") mode = "ss3";
        else if (char === ESC) mode = "escape";
        else if (char === "b" || char === "f" || char === "d" || char === "\x7f" || char === "\b") {
          emitKey(char === "b" ? "word-left" : char === "f" ? "word-right" : char === "d" ? "delete-word-after" : "delete-word-before");
        } else if (continuedEscape && index === 0) {
          result.continuation = false;
          index--;
        }
        continue;
      }
      if (mode === "ss3") {
        mode = char === ESC ? "escape" : "text";
        emitKey(sequenceKey(`O${char}`));
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
        if (/[\x40-\x7e]/.test(char) || (char === "$" && control === "3")) {
          mode = "text";
          const sequence = `[${control}${char}`;
          if (overflow) continue;
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
            else if (!bare) emitKey(sequenceKey(sequence));
          }
        } else if (/[\x20-\x3f]/.test(char)) {
          // Bound buffering even for an unterminated or malicious CSI stream.
          if (control.length < 128) control += char;
          else overflow = true;
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
        overflow = false;
      } else {
        append(char);
      }
    }
    return result;
  };

  return { read, strip: (value: string) => read(value).text };
}

function controlKey(code: number): TerminalInputKey | null {
  switch (code) {
    case 1: return "start";
    case 5: return "end";
    case 21: return "clear-before";
    case 11: return "clear-after";
    case 23: return "delete-word-before";
    case 4: return "delete-forward";
    case 8: case 127: return "delete-backward";
    default: return null;
  }
}

function modifiedKey(code: number, modifiers: number): TerminalInputKey | null {
  if (!Number.isInteger(modifiers) || modifiers < 1 || modifiers > 256) return null;
  const bits = modifiers - 1;
  const word = Boolean(bits & (2 | 4 | 8 | 32));
  if (code === 8 || code === 127) return word ? "delete-word-before" : "delete-backward";
  if (code === 13) return bits & 4 ? "steer" : "enter";
  if (bits & 4 && code >= 97 && code <= 122) return controlKey(code - 96);
  if (bits & (2 | 8 | 32)) {
    if (code === 98) return "word-left";
    if (code === 102) return "word-right";
    if (code === 100) return "delete-word-after";
  }
  return null;
}

function sequenceKey(sequence: string): TerminalInputKey | null {
  // CSI-u / kitty keyboard events and xterm modifyOtherKeys. Releases are not
  // edits; press and repeat have identical semantics. Unknown reports stay inert.
  const unicode = /^\[(\d+)(?:;(\d+)(?::([123]))?)?u$/.exec(sequence);
  if (unicode) return unicode[3] === "3" ? null : modifiedKey(Number(unicode[1]), Number(unicode[2] ?? 1));
  const other = /^\[27;(\d+);(\d+)~$/.exec(sequence);
  if (other) return modifiedKey(Number(other[2]), Number(other[1]));
  if (sequence === "[3$") return "delete-forward";
  if (sequence === "[3^") return "delete-word-after";
  const key = /^(?:\[|O)(\d*)(?:;(\d+)(?::([123]))?)?([A-DHF~a-d])$/.exec(sequence);
  if (!key || key[3] === "3") return null;
  const number = Number(key[1] || 1);
  const modifiers = Number(key[2] ?? 1);
  if (!Number.isSafeInteger(number) || !Number.isInteger(modifiers) || modifiers < 1 || modifiers > 256) return null;
  const word = Boolean((modifiers - 1) & (2 | 4 | 8 | 32));
  if (key[4] === "~") {
    if (!sequence.startsWith("[")) return null;
    if (number === 3) return word ? "delete-word-after" : "delete-forward";
    if (number === 1 || number === 7) return "start";
    if (number === 4 || number === 8) return "end";
    return null;
  }
  // rxvt's CSI 5C/5D and lowercase/SS3 arrows are also understood by Ink.
  if (number !== 1 && !(number === 5 && !key[2] && (key[4] === "C" || key[4] === "D"))) return null;
  switch (key[4]) {
    case "H": return "start";
    case "F": return "end";
    case "A": case "a": return "up";
    case "B": case "b": return "down";
    case "C": return word || number === 5 ? "word-right" : "right";
    case "D": return word || number === 5 ? "word-left" : "left";
    case "c": return sequence.startsWith("O") ? "word-right" : "right";
    case "d": return sequence.startsWith("O") ? "word-left" : "left";
    default: return null;
  }
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
