import React from "react";
import { Text } from "ink";
import { cleanup, render, flushTui } from "./helpers/tui.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFocusNavigation, type FocusItem } from "../src/tui/hooks/useFocusNavigation.js";

afterEach(cleanup);
const items: FocusItem[] = [
  { id: "left", row: 0, column: 0, bounds: { x: 1, y: 1, width: 10, height: 5 } },
  { id: "editor", row: 0, column: 1, redirectTo: "input", bounds: { x: 12, y: 1, width: 20, height: 5 } },
  { id: "input", row: 1, column: 1, parentIds: ["editor"], bounds: { x: 13, y: 3, width: 18, height: 2 } },
  { id: "right", row: 0, column: 2, bounds: { x: 33, y: 1, width: 10, height: 5 } },
];

function mount(initialId = "input") {
  const onQuit = vi.fn();
  let focus: ReturnType<typeof useFocusNavigation>;
  function Harness({ targets }: { targets: FocusItem[] }) {
    focus = useFocusNavigation({ items: targets, initialId, onQuit });
    return React.createElement(Text, null, focus.activeId);
  }
  const utils = render(React.createElement(Harness, { targets: items }));
  return {
    ...utils, onQuit,
    get focus() { return focus; },
    async key(value: string) { utils.write(value); await flushTui(); },
    async targets(targets: FocusItem[]) { utils.rerender(React.createElement(Harness, { targets })); await flushTui(); },
  };
}

describe("focus input events", () => {
  it("tabs in both directions without getting trapped by a parent redirect", async () => {
    const ui = mount();
    await flushTui();
    await ui.key("\x1b[Z");
    expect(ui.focus.activeId).toBe("left");
    await ui.key("\t");
    expect(ui.focus.activeId).toBe("input");
    await ui.key("\t");
    expect(ui.focus.activeId).toBe("right");
    await ui.key("\t");
    expect(ui.focus.activeId).toBe("left");
  });

  it("composes rapid Tab events against the live focus", async () => {
    const ui = mount("left");
    await flushTui();
    ui.stdin.write("\t");
    ui.stdin.write("\t");
    await flushTui();
    expect(ui.focus.activeId).toBe("right");
  });

  it("resolves redirects for initial and programmatic panel focus", async () => {
    const ui = mount("editor");
    await flushTui();
    expect(ui.focus.activeId).toBe("input");
    expect(ui.focus.focusState("editor")).toBe("ancestor");
    ui.focus.setActivePanel(1);
    await flushTui();
    expect(ui.focus.activeId).toBe("input");
  });

  it("does not interpret pasted q or Tab as quit or focus movement", async () => {
    const ui = mount("left");
    await flushTui();
    for (const chunk of ["\x1b[200~", "q", "\t", "\x1b[201~"]) await ui.key(chunk);
    expect(ui.onQuit).not.toHaveBeenCalled();
    expect(ui.focus.activeId).toBe("left");
    await ui.key("q");
    expect(ui.onQuit).toHaveBeenCalledOnce();
  });

  it("focuses on a split left click but ignores other buttons and release", async () => {
    const ui = mount("left");
    await flushTui();
    await ui.key("\x1b[<0;13;");
    await ui.key("3M");
    expect(ui.focus.activeId).toBe("input");
    for (const sequence of ["\x1b[<2;2;2M", "\x1b[<0;2;2m", "\x1b[<32;2;2M"]) await ui.key(sequence);
    expect(ui.focus.activeId).toBe("input");
    expect(ui.focus.focusState("editor")).toBe("ancestor");
  });

  it("retains input focus for arrows, preserves focus after resize, and uses new hit bounds", async () => {
    const ui = mount();
    await flushTui();
    for (const sequence of ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D", "q"]) await ui.key(sequence);
    expect(ui.focus.activeId).toBe("input");
    expect(ui.onQuit).not.toHaveBeenCalled();
    await ui.targets(items.map((item) => ({ ...item, bounds: item.bounds && { ...item.bounds, y: item.bounds.y + 10 } })));
    expect(ui.focus.activeId).toBe("input");
    await ui.key("\x1b[<0;2;2M");
    expect(ui.focus.activeId).toBe("input");
    await ui.key("\x1b[<0;2;12M");
    expect(ui.focus.activeId).toBe("left");
  });

  it("recovers when focused items disappear, including an empty target list", async () => {
    const ui = mount();
    await flushTui();
    await ui.targets([items[0], items[3]]);
    expect(ui.focus.activeId).toBe("left");
    await ui.targets([]);
    await ui.key("\t");
    expect(ui.focus.activeId).toBe("");
    expect(ui.focus.activeItem).toBeUndefined();
    await ui.targets(items);
    expect(ui.focus.activeId).toBe("left");
  });
});
