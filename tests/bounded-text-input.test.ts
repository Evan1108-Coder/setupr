import { afterEach, describe, expect, it } from "vitest";
import React, { act, useState } from "react";
import { cleanup, render, flushTui } from "./helpers/tui.js";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { BoundedTextInput } from "../src/tui/components/BoundedTextInput.js";
import { ChatInput } from "../src/tui/components/ChatInput.js";
import { EnvInput } from "../src/tui/components/EnvInput.js";
import { PromptCard } from "../src/tui/components/PromptCard.js";

afterEach(cleanup);

// Drive the real component through Ink's stdin emitter, including unflushed
// bursts and arbitrarily fragmented reads, rather than mocking key flags.
function mountInput(initial = "", width = 40, options: Partial<React.ComponentProps<typeof BoundedTextInput>> = {}) {
  const state = { value: initial, submitted: null as string | null, steer: false };
  let setExternalValue: (next: string) => void;

  function Harness() {
    const [value, setValue] = useState(initial);
    setExternalValue = setValue;
    state.value = value;
    return React.createElement(BoundedTextInput, {
      value,
      onChange: (next: string) => {
        setValue(next);
        state.value = next;
      },
      onSubmit: (text: string, meta?: { steer?: boolean }) => {
        state.submitted = text;
        state.steer = Boolean(meta?.steer);
      },
      focus: true,
      width,
      ...options,
    });
  }

  const utils = render(React.createElement(Harness));
  return {
    ready: flushTui,
    write: (s: string) => utils.stdin.write(s),
    async type(text: string) {
      for (const ch of text) {
        utils.write(ch);
      }
      await flushTui();
    },
    async key(seq: string) {
      utils.write(seq);
      await flushTui();
    },
    frame: () => utils.lastFrame(),
    async reset(next: string) { act(() => setExternalValue(next)); await flushTui(); },
    async focus(focus: boolean) {
      options = { ...options, focus };
      utils.rerender(React.createElement(Harness));
      await flushTui();
    },
    async resize(nextWidth: number) {
      width = nextWidth;
      utils.rerender(React.createElement(Harness));
      await flushTui();
    },
    get value() {
      return state.value;
    },
    get submitted() {
      return state.submitted;
    },
    get steer() {
      return state.steer;
    },
    cleanup: () => utils.unmount(),
  };
}

const BACKSPACE = "\x7f"; // macOS Backspace key
const FN_DELETE = "\x1b[3~"; // Fn+Delete / forward-delete key
const CTRL_D = "\x04"; // forward delete shortcut
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("BoundedTextInput key handling", () => {
  it("types plain characters without inserting spaces", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("hello");
    expect(input.value).toBe("hello");
    input.cleanup();
  });

  it("does not scramble or drop characters under a rapid keystroke burst", async () => {
    const input = mountInput();
    await input.ready();
    // Fire the whole phrase with no render gap between keystrokes — the case
    // that previously read stale closure state and produced e.g. "hlowrd".
    for (const ch of "hello world") input.write(ch);
    await flushTui();
    expect(input.value).toBe("hello world");
    input.cleanup();
  });

  it("Backspace (\\x7f) deletes the character before the cursor", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("hello");
    expect(input.value).toBe("hello");
    await input.key(BACKSPACE);
    expect(input.value).toBe("hell");
    await input.key(BACKSPACE);
    expect(input.value).toBe("hel");
    input.cleanup();
  });

  it("Backspace mid-string removes the char left of the cursor only", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("abcd");
    await input.key(LEFT); // cursor: abc|d
    await input.key(BACKSPACE); // removes 'c'
    expect(input.value).toBe("abd");
    input.cleanup();
  });

  it("Backspace at start of input is a no-op", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("ab");
    await input.key(LEFT);
    await input.key(LEFT); // cursor at 0
    await input.key(BACKSPACE);
    expect(input.value).toBe("ab");
    input.cleanup();
  });

  it("Fn+Delete deletes forward and is a no-op at the end", async () => {
    const input = mountInput("hello");
    await input.ready();
    await input.key(FN_DELETE);
    expect(input.value).toBe("hello");
    await input.key(LEFT);
    await input.key(FN_DELETE);
    expect(input.value).toBe("hell");
    input.cleanup();
  });

  it("Ctrl+D forward-deletes the character after the cursor", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("hello");
    await input.key(LEFT); // hell|o
    await input.key(CTRL_D); // removes 'o'
    expect(input.value).toBe("hell");
    input.cleanup();
  });

  it("inserts typed characters at the cursor position", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("ac");
    await input.key(LEFT); // a|c
    await input.type("b"); // ab|c
    expect(input.value).toBe("abc");
    input.cleanup();
  });

  it("submits on Enter", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("ship it");
    await input.key("\r");
    expect(input.submitted).toBe("ship it");
    input.cleanup();
  });

  it("clears the line before the cursor with Ctrl+U", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("delete me");
    await input.key("\x15");
    expect(input.value).toBe("");
    input.cleanup();
  });

  it("keeps borders intact: long text wraps within width and never exceeds it", async () => {
    const input = mountInput("", 20);
    await input.ready();
    await input.type("the quick brown fox jumps over the lazy dog repeatedly today");
    const frame = input.frame() ?? "";
    const longest = Math.max(...frame.split("\n").map((l) => l.length));
    // Each visible line is bounded by the wrap width; nothing bleeds past it.
    expect(longest).toBeLessThanOrEqual(20);
    expect(input.value).toContain("repeatedly today");
    input.cleanup();
  });

  it("preserves unicode and emoji characters", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("héllo 日本 🎉 café");
    expect(input.value).toBe("héllo 日本 🎉 café");
    input.cleanup();
  });

  it("accepts a large single-chunk paste without dropping characters", async () => {
    const input = mountInput("", 60);
    await input.ready();
    input.write("x".repeat(2000));
    await flushTui();
    expect(input.value.length).toBe(2000);
    input.cleanup();
  });

  it("keeps a masked field's real value intact while typing", async () => {
    const input = mountInput("", 40, { mask: "*" });
    await input.ready();
    await input.type("secret123");
    expect(input.value).toBe("secret123");
    expect(stripAnsi(input.frame() ?? "")).toBe("*********▌");
    input.cleanup();
  });

  it("strips control characters and ANSI escape injection from typed input", async () => {
    const input = mountInput();
    await input.ready();
    input.write("a\x1b[31mb\x07c\x00d");
    await flushTui();
    expect(input.value).toBe("abcd");
    input.cleanup();
  });

  it("clears fully under a backspace spam burst without underflowing", async () => {
    const input = mountInput();
    await input.ready();
    await input.type("abcdefghij");
    for (let i = 0; i < 15; i++) input.write(BACKSPACE);
    await flushTui();
    expect(input.value).toBe("");
    // Typing after over-deleting must still append from an empty, valid state.
    await input.type("ok");
    expect(input.value).toBe("ok");
    input.cleanup();
  });
});

describe("BoundedTextInput regressions", () => {
  it.each(["\r", "\n", "\r\n"])("submits coalesced single-line typing plus %j without adding a newline", async (enter) => {
    const input = mountInput();
    await input.ready();
    await input.key(`API_KEY=smoke-value${enter}`);
    expect(input.submitted).toBe("API_KEY=smoke-value");
    expect(input.value).toBe("API_KEY=smoke-value");
  });

  it("inserts coalesced text at the live caret before submitting", async () => {
    const input = mountInput("ac");
    await input.ready();
    await input.key(LEFT);
    await input.key("b\r");
    expect(input.submitted).toBe("abc");
    expect(input.value).toBe("abc");
  });

  it("does not submit twice when CRLF arrives in separate chunks", async () => {
    const submissions: string[] = [];
    const input = mountInput("", 40, { onSubmit: (value) => { submissions.push(value); } });
    await input.ready();
    await input.key("one\r");
    await input.key("\n");
    expect(submissions).toEqual(["one"]);
  });

  it("keeps bracketed trailing Enter and unbracketed multiline input as text", async () => {
    for (const [chunks, expected] of [
      [["\x1b[200~one\r\x1b[201~"], "one\n"],
      [["\x1b[200~", "one\rtwo\r", "\x1b[201~"], "one\ntwo\n"],
      [["one\rtwo\r"], "one\ntwo\n"],
    ] as const) {
      const input = mountInput();
      await input.ready();
      for (const chunk of chunks) await input.key(chunk);
      expect(input.submitted).toBeNull();
      expect(input.value).toBe(expected);
      input.cleanup();
    }
  });

  it("accepts a parent reset to a previously emitted value without retaining old edits", async () => {
    const input = mountInput();
    await input.ready();
    for (const char of "abc") input.write(char);
    await flushTui();
    await input.reset("a");
    await input.key("!");
    expect(input.value).toBe("a!");
    await input.reset("");
    await input.key("next");
    expect(input.value).toBe("next");
  });

  it("drains split reports while unfocused without editing or leaking their tails later", async () => {
    const input = mountInput("draft");
    await input.ready();
    await input.key("\x1b[<0;");
    await input.focus(false);
    await input.key("2;3M");
    await input.key("unfocused");
    expect(input.value).toBe("draft");
    await input.focus(true);
    await input.key("123");
    expect(input.value).toBe("draft123");
  });

  it("keeps ordinary typing after Escape and literal bracket text", async () => {
    const input = mountInput();
    await input.ready();
    await input.key("\x1b");
    await input.key("hello");
    await input.key("arr[200]=literal");
    expect(input.value).toBe("helloarr[200]=literal");
  });

  it("does not submit or edit while a split OSC payload consumes key-shaped chunks", async () => {
    const input = mountInput("draft");
    await input.ready();
    for (const chunk of ["\x1b]0;", "\r", "\x15", "\x07"]) await input.key(chunk);
    expect(input.submitted).toBeNull();
    expect(input.value).toBe("draft");
    await input.key("!");
    expect(input.value).toBe("draft!");
  });

  it("places the caret on the click that activates an unfocused field", async () => {
    const input = mountInput("abcd", 20, {
      focus: false, scrollBounds: { x: 3, y: 2, width: 20, height: 4 },
    });
    await input.ready();
    // The rendered field starts at (1,1); stale layout estimates must not win.
    await input.key("\x1b[<0;3;1M");
    await input.focus(true);
    await input.key("!");
    expect(input.value).toBe("ab!cd");
  });

  it("supports forward-word movement/deletion, clear-after, and Ctrl+Enter steer", async () => {
    const input = mountInput("one two three");
    await input.ready();
    await input.key("\x01");
    await input.key("\x1bf");
    await input.key("\x1bd");
    expect(input.value).toBe("one three");
    await input.key("\x0b");
    expect(input.value).toBe("one");
    await input.key("\x1b[13;5u");
    expect(input.submitted).toBe("one");
    expect(input.steer).toBe(true);
  });

  it.each(["\u{1f389}", "e\u0301", "\u{1f469}\u200d\u{1f4bb}", "\u{1f1e8}\u{1f1f3}", "\u{1f44d}\u{1f3fd}"])("edits whole grapheme %s", async (glyph) => {
    const input = mountInput(`a${glyph}b`);
    await input.ready();
    await input.key(LEFT);
    await input.key(BACKSPACE);
    expect(input.value).toBe("ab");
    await input.key(glyph);
    await input.key(LEFT);
    await input.key(CTRL_D);
    expect(input.value).toBe("ab");
    await input.key(glyph);
    await input.key(LEFT);
    await input.key(RIGHT);
    await input.key("!");
    expect(input.value).toBe(`a${glyph}!b`);
  });

  it.each(["\x1bb", "\x1b[1;3D", "\x1b[1;5D"])("moves one word left using %j through Ink", async (sequence) => {
    const input = mountInput("one two");
    await input.ready();
    await input.key(sequence);
    await input.key("!");
    expect(input.value).toBe("one !two");
  });

  it.each(["\x1b\x7f", "\x1b\b", "\x17"])("deletes a word backward using %j through Ink", async (sequence) => {
    const input = mountInput("one two");
    await input.ready();
    await input.key(sequence);
    expect(input.value).toBe("one ");
  });

  it("supports Home/End without inserting sequence suffixes", async () => {
    const input = mountInput("middle");
    await input.ready();
    await input.key("\x1b[H");
    await input.key("a");
    await input.key("\x1bOF");
    await input.key("z");
    expect(input.value).toBe("amiddlez");
  });

  it("does not insert letters for application Ctrl shortcuts", async () => {
    const input = mountInput("draft");
    await input.ready();
    for (const key of ["\x13", "\x12", "\x1b", "\t"]) await input.key(key);
    expect(input.value).toBe("draft");
  });

  it("keeps a newline-only bracketed paste as text, even with byte-split guards", async () => {
    const input = mountInput("before");
    await input.ready();
    for (const chunk of ["\x1b", "[", "2", "0", "0", "~", "\r", "\x1b[201", "~"]) await input.key(chunk);
    expect(input.submitted).toBeNull();
    expect(input.value).toBe("before\n");
    await input.key("after");
    await input.key("\r");
    expect(input.submitted).toBe("before\nafter");
  });

  it("preserves text coalesced with complete and split mouse reports", async () => {
    const input = mountInput();
    await input.ready();
    await input.key("one\x1b[<0;3;2Mtwo");
    for (const chunk of ["\x1b[<0;", "3;", "2Mthree"]) await input.key(chunk);
    expect(input.value).toBe("onetwothree");
  });

  it("wraps by terminal cells without dropping wide glyphs or splitting clusters", async () => {
    const input = mountInput("\u65e5\u672c\u{1f469}\u200d\u{1f4bb}e\u0301!", 4);
    await input.ready();
    const lines = stripAnsi(input.frame() ?? "").split("\n");
    expect(input.value).toBe("\u65e5\u672c\u{1f469}\u200d\u{1f4bb}e\u0301!");
    expect(lines.join("")).toContain("\u00e9!▌");
    expect(lines.every((line) => stringWidth(line) <= 4)).toBe(true);
  });

  it("uses display-only NFC and explicit escapes, never feeding them back into the draft", async () => {
    const value = "a\u65e5\u{1f389} e\u0301 \u{1f469}\u200d\u{1f4bb}";
    const input = mountInput(value, 80);
    await input.ready();
    expect(stripAnsi(input.frame() ?? "")).toBe("a\u65e5\u{1f389} \u00e9 \\u{1f469}\\u{200d}\\u{1f4bb}▌");
    await input.resize(12);
    await input.resize(80);
    await input.key("\r");
    expect(input.value).toBe(value);
    expect(input.submitted).toBe(value);
  });

  it("masks unsupported graphemes before presentation without exposing code-point escapes", async () => {
    const value = "\u{1f469}\u200d\u{1f4bb}q\u0301";
    const input = mountInput(value, 20, { mask: "*" });
    await input.ready();
    expect(stripAnsi(input.frame() ?? "")).toBe("**▌");
    await input.key("\r");
    expect(input.submitted).toBe(value);
  });

  it("shows the end caret at exact wrap boundaries and after narrowing/widening", async () => {
    const input = mountInput("abcdefghijklmnopqrst", 5, { maxLines: 2 });
    await input.ready();
    expect(stripAnsi(input.frame() ?? "")).toBe("pqrst\n▌");
    await input.resize(4);
    expect(stripAnsi(input.frame() ?? "")).toBe("qrst\n▌");
    await input.resize(30);
    expect(stripAnsi(input.frame() ?? "")).toBe("abcdefghijklmnopqrst▌");
    expect(input.value).toBe("abcdefghijklmnopqrst");
  });

  it("allows manual scrolling until the next edit, including modified wheel events", async () => {
    const input = mountInput("abcdefghijklmnopqrst", 5, { maxLines: 2 });
    await input.ready();
    await input.key("\x1b[A");
    expect(stripAnsi(input.frame() ?? "")).toBe("klmno\npqrst");
    await input.key("\x1b[<68;1;1M");
    expect(stripAnsi(input.frame() ?? "")).toBe("fghij\nklmno");
    await input.key("!");
    expect(stripAnsi(input.frame() ?? "")).toBe("pqrst\n!▌");
  });

  it("maps mouse columns to grapheme boundaries, including masked input", async () => {
    for (const mask of [undefined, "*"]) {
      const input = mountInput("a\u65e5\u{1f389}b", 20, {
        mask, scrollBounds: { x: 3, y: 2, width: 20, height: 4 },
      });
      await input.ready();
      await input.key(`\x1b[<0;${mask ? 3 : 4};1M`);
      await input.key("!");
      expect(input.value).toBe("a\u65e5!\u{1f389}b");
      input.cleanup();
    }
  });
});

describe("BoundedTextInput raw editing sequences", () => {
  it.each([BACKSPACE, "\b", "\x1b[127u", "\x1b[8;1u", "\x1b[27;1;127~"])("backward-deletes with %j, not Ink's ambiguous delete flag", async (sequence) => {
    const input = mountInput("abcd");
    await input.ready();
    await input.key(LEFT);
    await input.key(sequence);
    expect(input.value).toBe("abd");
  });

  it.each([FN_DELETE, "\x1b[3;2~", "\x1b[3$", CTRL_D])("forward-deletes with %j at the start and in the middle", async (sequence) => {
    const input = mountInput("abcd");
    await input.ready();
    await input.key(LEFT);
    await input.key(sequence);
    expect(input.value).toBe("abc");
    await input.key("\x01");
    await input.key(sequence);
    expect(input.value).toBe("bc");
  });

  it.each(["\x1b[3;3~", "\x1b[3;5~", "\x1b[3;6~", "\x1b[3^", "\x1bd"])("deletes the next word with %j", async (sequence) => {
    const input = mountInput("one two three");
    await input.ready();
    await input.key("\x01");
    await input.key("\x1bf");
    await input.key(sequence);
    expect(input.value).toBe("one three");
  });

  it.each(["\x1b[127;3u", "\x1b[127;5u", "\x1b[8;5u", "\x1b[27;5;127~", "\x1b[27;3;8~"])("deletes the previous word with %j", async (sequence) => {
    const input = mountInput("one two three");
    await input.ready();
    await input.key(sequence);
    expect(input.value).toBe("one two ");
  });

  it.each([BACKSPACE, "\b", FN_DELETE])("handles held %j across separate, coalesced, and byte-split reads", async (sequence) => {
    for (const chunks of [Array(15).fill(sequence), [sequence.repeat(15)], [...sequence.repeat(15)]]) {
      const input = mountInput("abcdefghij");
      await input.ready();
      if (sequence === FN_DELETE) await input.key("\x01");
      for (const chunk of chunks) input.write(chunk);
      await flushTui();
      expect(input.value).toBe("");
      await input.key("ok");
      expect(input.value).toBe("ok");
      input.cleanup();
    }
  });

  it.each([FN_DELETE, "\x1b[3;5~", "\x1b[127;5u", "\x1b[27;5;127~", "\x1b\x7f"])("preserves %j at every split boundary", async (sequence) => {
    const expected = sequence === FN_DELETE ? "one wo" : sequence.includes("[3;") ? "one " : "two";
    for (let split = 1; split < sequence.length; split++) {
      const input = mountInput("one two");
      await input.ready();
      await input.key(LEFT.repeat(3));
      await input.key(sequence.slice(0, split));
      await input.key(sequence.slice(split));
      expect(input.value, `split ${split}`).toBe(expected);
      input.cleanup();
    }
  });

  it("processes text, movement, deletion, and Enter in byte order in one read", async () => {
    const input = mountInput();
    await input.ready();
    await input.key(`abcd${LEFT}${LEFT}${FN_DELETE}${BACKSPACE}XY\r`);
    expect(input.value).toBe("aXYd");
    expect(input.submitted).toBe("aXYd");
  });

  it("handles press/repeat but ignores key-release events", async () => {
    const input = mountInput("abcdef");
    await input.ready();
    await input.key("\x1b[127;1:1u\x1b[127;1:2u\x1b[127;1:3u");
    expect(input.value).toBe("abcd");
    await input.key("\x01\x1b[3;1:1~\x1b[3;1:2~\x1b[3;1:3~");
    expect(input.value).toBe("cd");
  });

  it.each(["\u{1f389}", "e\u0301", "\u{1f469}\u200d\u{1f4bb}", "\u{1f1e8}\u{1f1f3}", "\u{1f44d}\u{1f3fd}"])("forward-deletes whole grapheme %s in a split sequence", async (glyph) => {
    const input = mountInput(`a${glyph}b`, 4, { maxLines: 2, mask: "*" });
    await input.ready();
    await input.key(LEFT.repeat(2));
    for (const byte of FN_DELETE) await input.key(byte);
    expect(input.value).toBe("ab");
    expect(stripAnsi(input.frame() ?? "")).toBe("*▌*");
  });

  it("keeps word deletion and movement on grapheme boundaries beside whitespace", async () => {
    const input = mountInput("one \u0301two");
    await input.ready();
    await input.key("\x17");
    expect(input.value).toBe("one \u0301");
    await input.key("\x01\x1bf!");
    expect(input.value).toBe("one! \u0301");
    await input.key("\x1bd");
    expect(input.value).toBe("one!");
  });

  it("keeps editing controls inert inside bracketed paste and resumes outside it in the same read", async () => {
    const input = mountInput("draft");
    await input.ready();
    await input.key(`\x1b[200~A${BACKSPACE}${FN_DELETE}\x17\x1b[127;5u\rB\x1b[201~${BACKSPACE}!`);
    expect(input.value).toBe("draftA\n!");
    expect(input.submitted).toBeNull();
  });

  it("drains editing sequences without applying them while unfocused", async () => {
    const input = mountInput("draft", 5, { focus: false, maxLines: 2 });
    await input.ready();
    await input.key(`${BACKSPACE.repeat(3)}${FN_DELETE}\x17`);
    await input.key("\x1b[3;");
    await input.key("5~");
    expect(input.value).toBe("draft");
    await input.focus(true);
    await input.key("!");
    expect(input.value).toBe("draft!");
    expect(stripAnsi(input.frame() ?? "").split("\n").every((line) => stringWidth(line) <= 5)).toBe(true);
  });

  it("preserves tabs in unbracketed pasted text while keeping standalone Tab out of the draft", async () => {
    const input = mountInput();
    await input.ready();
    await input.key("one\ttwo\nthree\tfour");
    expect(input.value).toBe("one\ttwo\nthree\tfour");
    await input.key("\t");
    expect(input.value).toBe("one\ttwo\nthree\tfour");
    expect(input.submitted).toBeNull();
  });

  it("normalizes CRLF but does not drop a later Enter after an edit", async () => {
    const submissions: string[] = [];
    const input = mountInput("abc", 40, { onSubmit: (value) => { submissions.push(value); } });
    await input.ready();
    await input.key("\r");
    await input.key(FN_DELETE);
    await input.key("\n");
    expect(submissions).toEqual(["abc", "abc"]);
  });

  it("keeps edits stable across every split of a mixed stream", async () => {
    const stream = `ab\u{1f389}cd${LEFT}${BACKSPACE}${FN_DELETE}XY${LEFT}!`;
    for (let split = 1; split < stream.length; split++) {
      const input = mountInput();
      await input.ready();
      await input.key(stream.slice(0, split));
      await input.key(stream.slice(split));
      expect(input.value, `split ${split}`).toBe("ab\u{1f389}X!Y");
      input.cleanup();
    }
  });

  it("does not replay edits or retain raw listeners after unmount/remount", async () => {
    const input = mountInput("first");
    await input.ready();
    await input.key("\x1b[3;");
    input.cleanup();
    const next = mountInput("second");
    await next.ready();
    await next.key(BACKSPACE.repeat(2));
    expect(input.value).toBe("first");
    expect(next.value).toBe("seco");
  });

  it("publishes one edit for a coalesced held-key read", async () => {
    const changes: string[] = [];
    const input = mountInput("x".repeat(300), 40, { onChange: (value) => { changes.push(value); } });
    await input.ready();
    input.write(BACKSPACE.repeat(350));
    await flushTui();
    expect(changes).toEqual([""]);
    await input.key("ok");
    expect(changes).toEqual(["", "ok"]);
  });
});

describe("shared input editing integration", () => {
  it.each(["chat", "env", "prompt"] as const)("edits and submits %s without changing masking, layout, or reset behavior", async (kind) => {
    const submissions: string[] = [];
    const onSubmit = (value: string) => { submissions.push(value); };
    const ui = render(kind === "chat"
      ? React.createElement(ChatInput, { active: true, isSensitive: true, width: 40, onSubmit })
      : kind === "env"
        ? React.createElement(EnvInput, { varKey: "TEST_VALUE", remainingCount: 1, focusState: "focused", isSensitive: true, width: 40, onSubmit, onSkip: () => {} })
        : React.createElement(PromptCard, { title: "Test", active: true, sensitiveInput: true, width: 40, onSubmit }));
    await flushTui();
    ui.write(`ab\u{1f389}cd${LEFT}${BACKSPACE}${FN_DELETE}XY`);
    await flushTui();
    const frame = stripAnsi(ui.lastFrame() ?? "");
    expect(frame).not.toContain("ab");
    expect(frame).not.toContain("XY");
    expect(frame).not.toContain("\\u{");
    expect(frame.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true);
    ui.write("\r");
    await flushTui();
    expect(submissions).toEqual(["ab\u{1f389}XY"]);
    ui.write("fresh\r");
    await flushTui();
    expect(submissions).toEqual(["ab\u{1f389}XY", "fresh"]);
  });
});
