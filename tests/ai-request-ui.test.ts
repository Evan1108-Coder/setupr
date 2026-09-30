import React, { act } from "react";
import { Text } from "ink";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, flushTui, render } from "./helpers/tui.js";
import { useAiRequest } from "../src/tui/hooks/useAiRequest.js";
import { ChatInput } from "../src/tui/components/ChatInput.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("AI request UI lifecycle", () => {
  it("blocks duplicate sends, reports progress, cancels with Escape and ignores late results", async () => {
    let api!: ReturnType<typeof useAiRequest>;
    const onCancel = vi.fn();
    const onError = vi.fn();
    function Harness() {
      api = useAiRequest({ onCancel, onError });
      return React.createElement(Text, null, api.pending ? api.label : "ready");
    }
    const ui = render(React.createElement(Harness));
    let signal!: AbortSignal;
    let complete!: (value: string) => void;
    let first!: Promise<string | undefined>;
    act(() => { first = api.run((request) => {
      signal = request.signal;
      request.onProgress("Waiting for test-model");
      return new Promise((resolve) => { complete = resolve; });
    }); });
    expect(ui.lastFrame()).toContain("Waiting for test-model");
    const duplicate = vi.fn(async () => "duplicate");
    await act(async () => { await api.run(duplicate); });
    expect(duplicate).not.toHaveBeenCalled();
    ui.write("\x1b");
    expect(signal.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(ui.lastFrame()).toBe("ready");
    await act(async () => { complete("late"); expect(await first).toBeUndefined(); });
    expect(onError).not.toHaveBeenCalled();
    await act(async () => { expect(await api.run(async () => "next")).toBe("next"); });
  });

  it("clears busy state on errors and aborts on unmount", async () => {
    let api!: ReturnType<typeof useAiRequest>;
    const onError = vi.fn();
    function Harness() {
      api = useAiRequest({ onError });
      return React.createElement(Text, null, api.pending ? "busy" : "ready");
    }
    const ui = render(React.createElement(Harness));
    const error = new Error("provider unavailable");
    await act(async () => { await api.run(async () => { throw error; }); });
    expect(onError).toHaveBeenCalledWith(error);
    expect(ui.lastFrame()).toBe("ready");
    let signal!: AbortSignal;
    act(() => { void api.run((request) => {
      signal = request.signal;
      return new Promise(() => {});
    }); });
    ui.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("keeps drafts visible while disabled or unfocused and retains them when enabled", async () => {
    const onSubmit = vi.fn();
    const props = { active: true, width: 60, onSubmit, maxLines: 3 };
    const ui = render(React.createElement(ChatInput, props));
    ui.write("draft before AI");
    ui.rerender(React.createElement(ChatInput, { ...props, disabled: true }));
    expect(ui.lastFrame()).toContain("draft before AI");
    ui.write("\r");
    expect(onSubmit).not.toHaveBeenCalled();
    ui.rerender(React.createElement(ChatInput, { ...props, active: false }));
    expect(ui.lastFrame()).toContain("draft before AI");
    ui.rerender(React.createElement(ChatInput, props));
    ui.write("\r");
    await flushTui();
    expect(onSubmit).toHaveBeenCalledWith("draft before AI", expect.anything());
  });
});
