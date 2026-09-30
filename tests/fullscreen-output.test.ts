import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { WriteStream } from "node:tty";
import React, { act, useState } from "react";
import { Box, Text, render, useInput } from "ink";
import ansiEscapes from "ansi-escapes";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFullscreenOutput } from "../src/cli/fullscreenOutput.js";

vi.mock("is-in-ci", () => ({ default: false }));

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});

class FakeTTY extends EventEmitter {
  isTTY = true;
  writableNeedDrain = false;
  writes: string[] = [];
  constructor(public columns = 24, public rows = 6) { super(); }
  write = vi.fn((chunk: string | Uint8Array, encodingOrCallback?: unknown, callback?: () => void) => {
    this.writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (done) queueMicrotask(() => done());
    return !this.writableNeedDrain;
  });
  get stream() { return this as unknown as WriteStream; }
  take() { return this.writes.splice(0).join(""); }
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

// A deliberately small terminal model for the adapter's output vocabulary. It
// rejects unsupported controls, out-of-range CUP, bottom-margin LF and ED.
class Screen {
  cells: string[][];
  backgrounds: string[][];
  row = 0;
  column = 0;
  background = "default";
  wrapPending = false;
  constructor(public columns: number, public rows: number) {
    this.cells = Array.from({ length: rows }, () => Array(columns).fill("?"));
    this.backgrounds = Array.from({ length: rows }, () => Array(columns).fill("old"));
  }
  apply(output: string) {
    for (let index = 0; index < output.length;) {
      if (output[index] === "\x1b") {
        const control = output.slice(index).match(/^\x1b\[([\d;?]*)([A-Za-z])/);
        expect(control, "complete CSI sequence").not.toBeNull();
        const [, parameters, operation] = control!;
        index += control![0].length;
        if (operation === "H") {
          const [row = 1, column = 1] = parameters.split(";").map(Number);
          expect(row).toBeGreaterThanOrEqual(1);
          expect(row).toBeLessThanOrEqual(this.rows);
          expect(column).toBeGreaterThanOrEqual(1);
          expect(column).toBeLessThanOrEqual(this.columns);
          this.row = row - 1;
          this.column = column - 1;
          this.wrapPending = false;
        } else if (operation === "K") {
          expect(parameters).toBe("");
          this.cells[this.row].fill(" ", this.column);
          this.backgrounds[this.row].fill(this.background, this.column);
        } else if (operation === "m") {
          for (const code of parameters.split(";").map(Number)) {
            if (code === 0 || code === 49) this.background = "default";
            if (code >= 40 && code <= 47) this.background = String(code);
          }
        } else {
          expect(["h", "l"]).toContain(operation);
          expect(["?2026", "?25"]).toContain(parameters);
        }
      } else {
        expect(output[index]).not.toBe("\n");
        expect(output[index]).not.toBe("\r");
        expect(this.wrapPending, "no printable character may trigger autowrap").toBe(false);
        this.cells[this.row][this.column] = output[index++];
        this.backgrounds[this.row][this.column] = this.background;
        if (this.column === this.columns - 1) this.wrapPending = true;
        else this.column++;
      }
    }
  }
  lines() { return this.cells.map((row) => row.join("").trimEnd()); }
}

function adapterFor(tty = new FakeTTY()) {
  const output = createFullscreenOutput(tty.stream);
  cleanup.push(output.dispose);
  return { tty, output };
}

function inkFor(node: React.ReactElement, tty: FakeTTY, adapted = true) {
  const output = adapted ? adapterFor(tty).output : undefined;
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  let instance!: ReturnType<typeof render>;
  act(() => {
    instance = render(node, {
      stdout: output?.stdout ?? tty.stream,
      debug: output?.debug ?? false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: new PassThrough() as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
  });
  cleanup.push(() => { act(() => instance.unmount()); instance.cleanup(); stdin.destroy(); });
  return {
    ...instance,
    rerender: (next: React.ReactElement) => act(() => instance.rerender(next)),
    input: async (text: string) => { await act(async () => { stdin.write(text); }); },
  };
}

function frame(lines: string[], height = lines.length, width = 24) {
  return React.createElement(Box, { height, width, flexDirection: "column" },
    ...lines.map((line, index) => React.createElement(Box, { key: index, height: 1, flexShrink: 0 },
      React.createElement(Text, null, line))));
}

describe("fullscreen output using the installed Ink renderer", () => {
  it("reproduces Ink 5's full clear on an unchanged full-height frame without the adapter", async () => {
    const tty = new FakeTTY();
    inkFor(frame(["Setupr setup"], tty.rows), tty, false);
    await delay(50);
    expect(tty.take()).toContain(ansiEscapes.clearTerminal);
    act(() => { tty.emit("resize"); });
    expect(tty.take()).toContain(ansiEscapes.clearTerminal);
  });

  it("sends messages without full clears and emits nothing for unchanged renders", async () => {
    const tty = new FakeTTY();
    function SetupHarness(_props: { revision: number }) {
      const [draft, setDraft] = useState("");
      const [message, setMessage] = useState("No messages");
      useInput((input, key) => {
        if (key.return) { setMessage(draft); setDraft(""); }
        else setDraft((value) => value + input);
      });
      return frame(["Setupr setup", message, "", "", "", `> ${draft}`], tty.rows);
    }
    const ui = inkFor(React.createElement(SetupHarness, { revision: 0 }), tty);
    const screen = new Screen(tty.columns, tty.rows);
    screen.apply(tty.take());
    await ui.input("hello");
    screen.apply(tty.take());
    await ui.input("\r");
    const sent = tty.take();
    expect(sent).not.toMatch(/\x1b\[(?:2|3)J/);
    expect(sent).not.toContain("Setupr setup");
    expect(sent.match(/\x1b\[\?2026h/g)).toHaveLength(1);
    expect(sent.endsWith("\x1b[?2026l")).toBe(true);
    screen.apply(sent);
    expect(screen.lines()).toEqual(["Setupr setup", "hello", "", "", "", ">"]);
    ui.rerender(React.createElement(SetupHarness, { revision: 1 }));
    expect(tty.take()).toBe("");
  });

  it("handles full/short/full/identical-short frames without Ink's stale log-update cache", () => {
    const tty = new FakeTTY();
    const ui = inkFor(frame(["full", "stale", "stale", "stale", "stale", "bottom"]), tty);
    const screen = new Screen(tty.columns, tty.rows);
    screen.apply(tty.take());
    for (const lines of [["short"], ["full", "2", "3", "4", "5", "bottom"], ["short"], []]) {
      ui.rerender(frame(lines));
      screen.apply(tty.take());
      expect(screen.lines()).toEqual(Array.from({ length: tty.rows }, (_, row) => lines[row] ?? ""));
    }
  });

  it("repaints unchanged text on resize, clips stale frames and erases newly exposed cells", () => {
    const tty = new FakeTTY(12, 4);
    const ui = inkFor(frame(["abcdefghijkl", "second", "third", "fourth"], 4, 12), tty);
    tty.take();
    act(() => { tty.resize(5, 2); });
    const smaller = new Screen(5, 2);
    smaller.apply(tty.take());
    expect(smaller.lines()).toEqual(["abcde", "secon"]);
    ui.rerender(frame(["tiny"], 1, 5));
    smaller.apply(tty.take());
    expect(smaller.lines()).toEqual(["tiny", ""]);
    act(() => { tty.resize(16, 6); });
    const larger = new Screen(16, 6);
    larger.apply(tty.take());
    expect(larger.lines()).toEqual(["tiny", "", "", "", "", ""]);
    ui.rerender(frame(["tiny"], 1, 5));
    expect(tty.take()).toBe("");
  });
});

describe("fullscreen output terminal safety and lifecycle", () => {
  it("keeps the last cell of full-width rows and never scrolls at the bottom margin", () => {
    const { tty, output } = adapterFor(new FakeTTY(5, 2));
    const screen = new Screen(5, 2);
    for (const text of ["ABCDE\n12345", "ABCDZ\n1234Z", "AB\nZ"]) {
      output.stdout.write(text);
      screen.apply(tty.take());
      expect(screen.lines()).toEqual(text.split("\n"));
    }
  });

  it("erases shortened rows and removed rows with the terminal's default background", () => {
    const { tty, output } = adapterFor(new FakeTTY(8, 3));
    const screen = new Screen(8, 3);
    output.stdout.write("\x1b[41mlong row\x1b[49m\nold row\nold end");
    screen.apply(tty.take());
    output.stdout.write("\x1b[41mnew\x1b[49m");
    const shortened = tty.take();
    expect(shortened.indexOf("new")).toBeLessThan(shortened.indexOf("\x1b[K"));
    screen.apply(shortened);
    expect(screen.lines()).toEqual(["new", "", ""]);
    expect(screen.backgrounds[0]).toEqual(["41", "41", "41", ...Array(5).fill("default")]);
    expect(screen.backgrounds.slice(1).flat().every((color) => color === "default")).toBe(true);
  });

  it("clips oversized Unicode at grapheme boundaries without emitting a partial escape", () => {
    const { tty, output } = adapterFor(new FakeTTY(4, 2));
    output.stdout.write("\x1b[31m\u65e5\u672c\u{1f469}\u200d\u{1f4bb}\x1b[39m\ne\u0301abcdef");
    const text = tty.take();
    expect(stripAnsi(text)).toBe("\u65e5\u672ce\u0301abc");
    expect(text).not.toContain("\ufffd");
    expect(stripAnsi(text)).not.toContain("\x1b");
  });

  it("preserves cursor controls, write callbacks and backpressure for strings and byte arrays", async () => {
    const { tty, output } = adapterFor();
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    output.stdout.write(Buffer.from("hello"), callbacks[0]);
    tty.take();
    expect(output.stdout.write(new Uint8Array(Buffer.from("hello")), callbacks[1])).toBe(true);
    expect(tty.take()).toBe("");
    tty.writableNeedDrain = true;
    expect(output.stdout.write("changed", "utf8", callbacks[2])).toBe(false);
    expect(output.stdout.write("changed")).toBe(false);
    await Promise.resolve();
    expect(callbacks.map((callback) => callback.mock.calls.length)).toEqual([1, 1, 1]);
    tty.take();
    output.stdout.write("\x1b[?25l");
    output.stdout.write("\x1b[?25h");
    expect(tty.take()).toBe("\x1b[?25l\x1b[?25h");
  });

  it("never replaces real stdout.write, removes its resize listener and disposes idempotently", () => {
    const tty = new FakeTTY();
    const originalWrite = tty.write;
    const globalWrite = process.stdout.write;
    const originalListeners = tty.listenerCount("resize");
    const { output } = adapterFor(tty);
    expect(tty.write).toBe(originalWrite);
    expect(process.stdout.write).toBe(globalWrite);
    expect(tty.listenerCount("resize")).toBe(originalListeners + 1);
    output.stdout.write("hello");
    tty.take();
    output.dispose();
    expect(tty.take()).toBe("\x1b[?2026l\x1b[0m\x1b[?25h");
    expect(tty.listenerCount("resize")).toBe(originalListeners);
    output.dispose();
    tty.resize(20, 8);
    expect(tty.take()).toBe("");
    output.stdout.write("after\n");
    expect(tty.take()).toBe("after\n");
    expect(tty.write).toBe(originalWrite);
    expect(process.stdout.write).toBe(globalWrite);
  });

  it("orders a suppressed-frame callback after a previous asynchronous write", async () => {
    const completions: Array<() => void> = [];
    const writes: string[] = [];
    const stream = Object.assign(new Writable({
      write(chunk, _encoding, done) {
        writes.push(chunk.toString());
        completions.push(done);
      },
    }), { isTTY: true, columns: 8, rows: 2 });
    const output = createFullscreenOutput(stream as unknown as WriteStream);
    cleanup.push(() => {
      output.dispose();
      while (completions.length) completions.shift()!();
      stream.destroy();
    });
    const order: string[] = [];
    output.stdout.write("hello", () => order.push("first"));
    output.stdout.write("hello", () => order.push("unchanged"));
    await Promise.resolve();
    expect(order).toEqual([]);
    completions.shift()!();
    completions.shift()!();
    await Promise.resolve();
    expect(order).toEqual(["first", "unchanged"]);
    expect(writes[1]).toBe("");
  });

  it("leaves non-TTY output and renderer mode unchanged", () => {
    const tty = new FakeTTY();
    tty.isTTY = false;
    const output = createFullscreenOutput(tty.stream);
    expect(output.stdout).toBe(tty);
    expect(output.debug).toBe(false);
    output.stdout.write("plain\n");
    output.dispose();
    expect(tty.take()).toBe("plain\n");
    expect(tty.listenerCount("resize")).toBe(0);
  });
});
