import { describe, expect, it } from "vitest";
import { findDirectionalFocusItem, type FocusItem } from "../src/tui/hooks/useFocusNavigation.js";
import { createTerminalControlInputStripper, parseSgrMouse, stripTerminalControlInput } from "../src/tui/terminalInput.js";

const esc = "\x1b";

describe("terminal control input handling", () => {
  it("preserves pasted text with guards split at every byte boundary", () => {
    const paste = `${esc}[200~\u65e5\u672c\u{1f389}\r\nsecond${esc}[201~`;
    for (let split = 1; split < paste.length; split++) {
      const consumer = createTerminalControlInputStripper();
      expect(consumer.strip(paste.slice(0, split)) + consumer.strip(paste.slice(split))).toBe("\u65e5\u672c\u{1f389}\nsecond");
    }
  });

  it("recovers after a very long terminated control without retaining its payload", () => {
    const consumer = createTerminalControlInputStripper();
    expect(consumer.strip(`${esc}]0;${"x".repeat(100000)}`)).toBe("");
    expect(consumer.strip(`${esc}\\visible`)).toBe("visible");
    expect(consumer.strip(`${esc}[${"1;".repeat(100000)}mvisible`)).toBe("visible");
  });

  it.each([
    `${esc}[<0;78;17M`, `${esc}[M !#`, `${esc}]0;title${esc}\\`,
    `${esc}]0;title\x07`, `${esc}[31m`,
  ])("strips %j at every chunk boundary without eating following text", (sequence) => {
    for (let split = 1; split < sequence.length; split++) {
      const consumer = createTerminalControlInputStripper();
      const result = consumer.strip(`before${sequence.slice(0, split)}`)
        + consumer.strip(`${sequence.slice(split)}123after`);
      expect(result, `split at ${split}`).toBe("before123after");
    }
  });

  it("does not consume digits typed after an interrupted mouse report", () => {
    const consumer = createTerminalControlInputStripper();
    expect(consumer.strip(`${esc}[<0;`)).toBe("");
    expect(consumer.strip("hello")).toBe("hello");
    expect(consumer.strip("123")).toBe("123");
  });

  it("does not replay a complete bare paste marker as a prefix of the next value", () => {
    const consumer = createTerminalControlInputStripper();
    expect(consumer.strip("[200~")).toBe("");
    expect(consumer.strip("value[201~")).toBe("value");
    expect(consumer.strip("[200]=literal")).toBe("[200]=literal");
  });

  it("normalizes CRLF even when the pair is split between reads", () => {
    const consumer = createTerminalControlInputStripper();
    expect(consumer.strip("a\r") + consumer.strip("\nb")).toBe("a\nb");
  });

  it("strips complete SGR mouse reports before text input sees them", () => {
    const noisy = `${esc}[<0;78;17Mhello[<64;121;35M world${esc}[<0;78;17m`;

    expect(stripTerminalControlInput(noisy)).toBe("hello world");
  });

  it("strips SGR mouse reports when a terminal delivers them in split chunks", () => {
    expect(stripTerminalControlInput(`${esc}[<0;78;`)).toBe("");
    expect(stripTerminalControlInput("17Mtyped")).toBe("typed");
  });

  it("parses press and wheel reports for click focus and input scrolling", () => {
    expect(parseSgrMouse(`${esc}[<0;12;5M`)).toMatchObject({
      action: "press",
      x: 12,
      y: 5,
    });
    expect(parseSgrMouse(`${esc}[<65;12;5M`)).toMatchObject({
      action: "scroll",
      code: 65,
    });
  });

  it("strips bracketed paste markers even when split across chunks", () => {
    expect(stripTerminalControlInput(`${esc}[200`)).toBe("");
    expect(stripTerminalControlInput("~first\nsecond")).toBe("first\nsecond");
    expect(stripTerminalControlInput(`${esc}[201~`)).toBe("");
  });

  it("strips bare bracketed paste markers when Ink has already consumed the leading ESC", () => {
    // Ink's keypress parser frequently eats the leading ESC of a pasted chunk, so
    // the guards arrive as bare "[200~"/"[201~". These must not leak into the field.
    expect(stripTerminalControlInput("[200~hello world[201~")).toBe("hello world");
    expect(stripTerminalControlInput(`[200~API_KEY=sk-abc123${esc}[201~`)).toBe("API_KEY=sk-abc123");
  });

  it("does not eat ordinary bracket text or a lone typed bracket", () => {
    expect(stripTerminalControlInput("arr[200]=x")).toBe("arr[200]=x");
    expect(stripTerminalControlInput("[")).toBe("[");
  });

  it("holds a bare ESC-stripped paste marker that is split across chunks", () => {
    const consumer = createTerminalControlInputStripper();
    expect(consumer.strip("first[20")).toBe("first");
    expect(consumer.strip("0~second")).toBe("second");
  });

  it("preserves line breaks in multi-line pastes delivered as CR", () => {
    // Terminals send pasted newlines as CR (\r). The stripper must normalize CR/CRLF
    // to \n before dropping C0 controls, or multi-line KEY=value pastes collapse into
    // one line and parseEnvPairs sees a single mashed entry.
    expect(stripTerminalControlInput("A=1\rB=2\rC=3")).toBe("A=1\nB=2\nC=3");
    expect(stripTerminalControlInput("A=1\r\nB=2")).toBe("A=1\nB=2");
    expect(stripTerminalControlInput("[200~K1=v1\rK2=v2[201~")).toBe("K1=v1\nK2=v2");
  });

  it("buffers split CSI and OSC terminal controls instead of leaking suffix text", () => {
    expect(stripTerminalControlInput(`${esc}[1;3`)).toBe("");
    expect(stripTerminalControlInput("Dword")).toBe("word");
    expect(stripTerminalControlInput(`${esc}]0;Secret`)).toBe("");
    expect(stripTerminalControlInput(` Title${esc}\\visible`)).toBe("visible");
  });

  it("keeps split-control buffering isolated per input consumer", () => {
    const promptConsumer = createTerminalControlInputStripper();
    const textInputConsumer = createTerminalControlInputStripper();

    expect(promptConsumer.strip(`${esc}[<0;78;`)).toBe("");
    expect(textInputConsumer.strip(`${esc}[<0;78;`)).toBe("");
    expect(promptConsumer.strip("17M")).toBe("");
    expect(textInputConsumer.strip("17Mtyped")).toBe("typed");
  });
});

describe("visual focus navigation", () => {
  const items: FocusItem[] = [
    { id: "steps", row: 0, column: 0, bounds: { x: 1, y: 1, width: 40, height: 8 } },
    { id: "project", row: 0, column: 1, bounds: { x: 43, y: 1, width: 40, height: 8 } },
    { id: "diary", row: 1, column: 0, bounds: { x: 1, y: 10, width: 82, height: 20 } },
    { id: "input", row: 2, column: 0, parentIds: ["diary"], bounds: { x: 3, y: 25, width: 78, height: 4 } },
    { id: "details", row: 1, column: 1, bounds: { x: 85, y: 10, width: 35, height: 20 } },
  ];

  it("moves to the visually nearest panel in each direction", () => {
    expect(findDirectionalFocusItem(items, items[0], "right")?.id).toBe("project");
    expect(findDirectionalFocusItem(items, items[0], "down")?.id).toBe("diary");
    expect(findDirectionalFocusItem(items, items[2], "right")?.id).toBe("details");
    expect(findDirectionalFocusItem(items, items[4], "left")?.id).toBe("diary");
    expect(findDirectionalFocusItem(items, items[2], "up")?.id).toBe("steps");
  });
}
);
