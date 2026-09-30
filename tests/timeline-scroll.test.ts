import React from "react";
import { Box } from "ink";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "./helpers/tui.js";
import { Timeline, type TimelineEvent } from "../src/tui/components/Timeline.js";

afterEach(cleanup);

const events: TimelineEvent[] = [{ id: "answer", kind: "assistant", content: Array.from({ length: 24 }, (_, i) => `Line ${String(i + 1).padStart(2, "0")}: project details`).join("\n") }];

describe("scrollable AI transcript", () => {
  it("hides old reasoning envelopes and terminal controls without hiding literal code tags", () => {
    const ui = render(React.createElement(Timeline, {
      events: [{ id: "old", kind: "assistant", content: "<think>private fixture</think>Visible answer\n```xml\n<think>literal code</think>\n```\n\x1b]52;c;hidden-payload\x07Done" }],
      maxItems: 12, width: 80,
    }));
    expect(ui.lastFrame()).toContain("Visible answer");
    expect(ui.lastFrame()).toContain("<think>literal code</think>");
    expect(ui.lastFrame()).not.toContain("private fixture");
    expect(ui.lastFrame()).not.toContain("hidden-payload");
  });

  it("keeps the full answer reachable instead of silently truncating at three lines", () => {
    const ui = render(React.createElement(Timeline, { events, maxItems: 7, width: 50, active: true }));
    expect(ui.lastFrame()).toContain("Line 24");
    expect(ui.lastFrame()).not.toContain("Line 01");
    for (let i = 0; i < 5; i++) ui.write("\x1b[5~");
    expect(ui.lastFrame()).toContain("Line 01");
    expect(ui.lastFrame()).toContain("lines below");
    for (let i = 0; i < 5; i++) ui.write("\x1b[6~");
    expect(ui.lastFrame()).toContain("Line 24");
  });

  it("scrolls only when the mouse is over the transcript", () => {
    const ui = render(React.createElement(Box, { width: 55, height: 10, padding: 1 },
      React.createElement(Timeline, { events, maxItems: 7, width: 50 })));
    const initial = ui.lastFrame();
    ui.write("\x1b[<64;60;3M");
    expect(ui.lastFrame()).toBe(initial);
    ui.write("\x1b[<64;3;3M");
    expect(ui.lastFrame()).not.toContain("Line 24");
    expect(ui.lastFrame()).toContain("3 lines below");
  });

  it.each([18, 40, 80, 160])("wraps Unicode and multiline code within %i cells", (width) => {
    const content = "First line\n```sh\n" + "\u65e5\u672c\u{1f469}\u200d\u{1f4bb} ".repeat(30) + "\n```\nLast line";
    const ui = render(React.createElement(Box, { width }, React.createElement(Timeline, {
      events: [{ id: "unicode", kind: "assistant", content }], maxItems: 8, width, active: true,
    })));
    const frame = stripAnsi(ui.lastFrame() || "");
    expect(frame).toContain("Last line");
    expect(frame).not.toContain("\ufffd");
    expect(frame.split("\n").every((line) => stringWidth(line) <= width)).toBe(true);
    for (let i = 0; i < 20; i++) ui.write("\x1b[5~");
    expect(ui.lastFrame()).toContain("First line");
  });
});
