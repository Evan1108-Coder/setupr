import React, { act } from "react";
import { Box, Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import stringWidth from "string-width";
import { markdownRows } from "../src/tui/markdown.js";
import { Timeline } from "../src/tui/components/Timeline.js";
import { ChatInput } from "../src/tui/components/ChatInput.js";
import { cleanup, render, flushTui } from "./helpers/tui.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const sample = '# Project\n\n**Bold** and *italic* with `npm run dev` and ~~obsolete~~.\n\n1. Install packages with npm before starting the local server.\n2. Check env.\n\n```sh\necho "literal **markers**"\n```\n\n|Name|State|\n|---|---|\n|API|Ready|\n\n> A quoted note.\n\n[Docs](https://example.test/docs)';
describe("terminal Markdown", () => {
  it("does not animate a disabled input when no work is pending", async () => {
    vi.useFakeTimers();
    const ui = render(React.createElement(ChatInput, { active: false, disabled: true, busy: false, disabledText: "Finished", width: 60, onSubmit: () => {} }));
    const first = ui.lastFrame();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(ui.lastFrame()).toBe(first);
    expect(first).toContain("Finished");
  });
  it("animates pending AI input without changing its dimensions", async () => {
    vi.useFakeTimers();
    const ui = render(React.createElement(ChatInput, { active: true, disabled: true, disabledText: "AI: Waiting for model", width: 60, onSubmit: () => {} }));
    const first = ui.lastFrame()!;
    await act(async () => { vi.advanceTimersByTime(100); });
    const second = ui.lastFrame()!;
    expect(second).not.toBe(first);
    expect(second).toContain("Waiting for model");
    expect(first.split("\n").length).toBe(second.split("\n").length);
    expect(second.split("\n").every(line => stringWidth(line) <= 60)).toBe(true);
  });
  it("keeps a word separator when wrapping on a space moves the preceding word", () => {
    const text = "Chat session ready. Ask about this project, steer a plan, paste env values, or ask me to inspect status.";
    for (let width = 15; width < 110; width++) {
      const rendered = markdownRows(text, width).map(row => row.map(s => s.text).join("")).join(" ").replace(/\s+/g, " ").trim();
      expect(rendered).toBe(text);
    }
  });
  it("preserves semantic styling, lists, code and table data", () => {
    const rows = markdownRows(sample, 70);
    const spans = rows.flat();
    expect(spans.some(s => s.bold && s.text.includes("Bold"))).toBe(true);
    expect(spans.some(s => s.italic && s.text.includes("italic"))).toBe(true);
    expect(spans.some(s => s.strikethrough && s.text.includes("obsolete"))).toBe(true);
    const text = rows.map(row => row.map(s => s.text).join("")).join("\n");
    expect(text).toContain('echo "literal **markers**"');
    expect(text).toContain("Name: API");
    expect(text).toContain("1. Install");
    expect(text).not.toContain("**Bold**");
  });
  it.each([1, 4, 12, 18, 40, 80, 160])("keeps every row within %i cells", width => {
    const rows = markdownRows(sample + '\n\n' + '超长内容'.repeat(30) + '\n\n' + 'a'.repeat(400), width);
    for (const row of rows) expect(stringWidth(row.map(s => s.text).join(""))).toBeLessThanOrEqual(width);
  });
  it("does not emit escape sequences from encoded or raw input", () => {
    const rows = markdownRows("hello &#x1b;[2J \x1b]52;c;c2VjcmV0\x07 **safe**", 50);
    expect(JSON.stringify(rows)).not.toContain("\\u001b");
    expect(JSON.stringify(rows)).not.toContain("c2VjcmV0");
  });
  it.each([10, 24, 50])("puts the last transcript row directly above the input at height %i", async height => {
    const events = [{ id: "one", kind: "assistant" as const, content: "The project is ready." }];
    const ui = render(React.createElement(Box, { height, width: 60, flexDirection: "column" },
      React.createElement(Timeline, { events, fill: true, width: 60 }),
      React.createElement(Text, {}, "INPUT")));
    await flushTui();
    const lines = ui.lastFrame()!.split("\n");
    const input = lines.findIndex(line => line.includes("INPUT"));
    expect(lines[input - 1]).toContain("The project is ready.");
    expect(lines.length).toBeLessThanOrEqual(height);
  });
});
