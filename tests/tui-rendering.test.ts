import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, render, flushTui } from "./helpers/tui.js";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { ChatInput } from "../src/tui/components/ChatInput.js";
import { Panel } from "../src/tui/components/Panel.js";
import { Box, Text } from "ink";
import { useTerminalSize } from "../src/tui/hooks/useTerminalSize.js";

afterEach(cleanup);

// Measure terminal cells, not UTF-16 length or the number of code points.
function lineWidths(frame: string | undefined): number[] {
  return stripAnsi(frame ?? "")
    .split("\n")
    .map((line) => stringWidth(line));
}

describe("TUI rendering integrity", () => {
  it("clears the controlled chat draft after coalesced submission without replaying old text", () => {
    const submissions: string[] = [];
    const ui = render(React.createElement(ChatInput, { active: true, width: 60, onSubmit: (value: string) => submissions.push(value) }));
    ui.write("first\r");
    expect(submissions).toEqual(["first"]);
    expect(ui.lastFrame()).not.toContain("first");
    ui.write("second\r");
    expect(submissions).toEqual(["first", "second"]);
    expect(ui.lastFrame()).not.toContain("second");
  });

  it("keeps the bounded input at the bottom when terminal columns and rows resize", async () => {
    function TerminalHarness() {
      const terminal = useTerminalSize();
      return React.createElement(Box, { flexDirection: "column", width: terminal.width, height: terminal.height },
        React.createElement(Box, { flexGrow: 1 }, React.createElement(Text, null, "Transcript")),
        React.createElement(ChatInput, { active: true, width: terminal.width, maxLines: 3, onSubmit: () => {} })
      );
    }
    const ui = render(React.createElement(TerminalHarness));
    await flushTui();
    ui.stdin.write("\u65e5\u672c\u{1f389} ".repeat(80) + "END");
    await flushTui();
    for (const [width, height] of [[80, 24], [32, 12], [100, 30]]) {
      Object.defineProperty(ui.stdout, "columns", { configurable: true, value: width });
      Object.defineProperty(ui.stdout, "rows", { configurable: true, value: height });
      process.stdout.emit("resize");
      await flushTui();
      const frame = stripAnsi(ui.lastFrame() ?? "");
      const lines = frame.split("\n");
      expect(lines).toHaveLength(height);
      expect(stringWidth(lines.at(-1)!)).toBe(width);
      expect(lines.at(-2)).toContain("END▌");
      expect(lineWidths(frame).every((length) => length <= width)).toBe(true);
    }
  });

  it("keeps all chat rows rectangular and the caret visible across width changes", async () => {
    const onSubmit = () => {};
    const ui = render(React.createElement(ChatInput, { active: true, width: 60, maxLines: 3, onSubmit }));
    await flushTui();
    const value = "\u65e5\u672c\u{1f389}\u00e9 ".repeat(30) + "END";
    ui.stdin.write(`\x1b[200~${value}\x1b[201~`);
    await flushTui();
    for (const width of [60, 24, 80, 32]) {
      ui.rerender(React.createElement(ChatInput, { active: true, width, maxLines: 3, onSubmit }));
      await flushTui();
      const frame = stripAnsi(ui.lastFrame() ?? "");
      expect(lineWidths(frame)).toEqual(Array(5).fill(width));
      expect(frame).toContain("END▌");
      expect(frame).not.toContain("�");
    }
  });

  it.each(["e\u0301", "q\u0301", "\u{1f469}\u200d\u{1f4bb}", "\u{1f44d}\u{1f3fd}", "\u{1f1e8}\u{1f1f3}", "\u{1d11e}", "\u0915\u094d", "\u00a9", "\u26bd", "\u00a9\ufe0f"])("keeps bordered rows aligned for %s without changing submitted text", async (value) => {
    let submitted = "";
    const onSubmit = (text: string) => { submitted = text; };
    const ui = render(React.createElement(ChatInput, { active: true, width: 60, onSubmit }));
    ui.write(value);
    for (const width of [60, 30, 12, 60]) {
      ui.rerender(React.createElement(ChatInput, { active: true, width, onSubmit }));
      const frame = stripAnsi(ui.lastFrame() ?? "");
      expect(lineWidths(frame).every((cells) => cells === width)).toBe(true);
      expect(frame).toContain("▌");
    }
    ui.write("\r");
    expect(submitted).toBe(value);
  });

  it("keeps the chat input border a stable rectangle while typing a long line", async () => {
    const width = 60;
    const utils = render(React.createElement(ChatInput, { active: true, onSubmit: () => {}, width }));
    await flushTui();

    const long = "the quick brown fox jumps over the lazy dog ".repeat(5).trim();
    for (const ch of long) utils.stdin.write(ch);
    await flushTui();

    const widths = lineWidths(utils.lastFrame()).filter((w) => w > 0);
    // Every rendered row must be exactly the box width — no row longer (overflow
    // that "squishes"/wraps the border) and the border rows must not be ragged.
    const max = Math.max(...widths);
    expect(max).toBeLessThanOrEqual(width);
    // The top and bottom border rows span the full width; confirm at least two
    // rows hit the full width so the box stayed a clean rectangle.
    expect(widths.filter((w) => w === width).length).toBeGreaterThanOrEqual(2);
    utils.unmount();
  });

  it("renders a stable bordered Panel rectangle at multiple widths", () => {
    for (const width of [40, 60, 100]) {
      const utils = render(
        React.createElement(
          Panel,
          { title: "diagnostics", width, height: 6 },
          React.createElement(Text, null, "All systems nominal — checking dependencies and environment.")
        )
      );
      const widths = lineWidths(utils.lastFrame()).filter((w) => w > 0);
      expect(Math.max(...widths)).toBeLessThanOrEqual(width);
      // Top + bottom borders both span the full width.
      expect(widths.filter((w) => w === width).length).toBeGreaterThanOrEqual(2);
      utils.unmount();
    }
  });

  it("does not let a very long unbroken token overflow the input width", async () => {
    const width = 50;
    const utils = render(React.createElement(ChatInput, { active: true, onSubmit: () => {}, width }));
    await flushTui();
    const blob = "x".repeat(400);
    utils.stdin.write(blob);
    await flushTui();
    const widths = lineWidths(utils.lastFrame()).filter((w) => w > 0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(width);
    utils.unmount();
  });
});
