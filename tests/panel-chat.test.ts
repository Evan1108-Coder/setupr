import React, { act } from "react";
import { Text } from "ink";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, flushTui, render } from "./helpers/tui.js";
import type { IntelligenceOptions, IntelligenceResult } from "../src/ai/intelligence.js";
import { intelligentResponse } from "../src/ai/intelligence.js";
import type { ScanResult } from "../src/scanner/index.js";
import { usePanelChat } from "../src/tui/hooks/usePanelChat.js";
import { DoctorLayout } from "../src/tui/layouts/DoctorLayout.js";
import { StartLayout } from "../src/tui/layouts/StartLayout.js";
import { UpdateLayout } from "../src/tui/layouts/UpdateLayout.js";

type InputProps = { disabled: boolean; disabledText: string; onSubmit: (text: string) => Promise<void> };
const input = vi.hoisted(() => ({
  current: undefined as InputProps | undefined,
  mounted: vi.fn(),
  unmounted: vi.fn(),
  width: 100,
  height: 30,
  realInput: false,
}));

vi.mock("../src/ai/intelligence.js", () => ({ intelligentResponse: vi.fn() }));
vi.mock("../src/executor/index.js", () => ({
  runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
}));
vi.mock("../src/context/collector.js", () => ({ collectContext: vi.fn(async () => null) }));
vi.mock("../src/agent/runtime.js", () => ({ doctorInsights: vi.fn(() => []) }));
vi.mock("../src/tui/hooks/useTerminalSize.js", () => ({
  useTerminalSize: () => ({ width: input.width, height: input.height }),
}));
vi.mock("../src/tui/components/ChatInput.js", async () => {
  const { createElement, useEffect } = await import("react");
  const { Text } = await import("ink");
  const actual = await vi.importActual<typeof import("../src/tui/components/ChatInput.js")>("../src/tui/components/ChatInput.js");
  return {
    ChatInput: (props: InputProps) => {
      input.current = props;
      useEffect(() => { input.mounted(); return () => input.unmounted(); }, []);
      return input.realInput
        ? createElement(actual.ChatInput, props as React.ComponentProps<typeof actual.ChatInput>)
        : createElement(Text, null, props.disabled ? props.disabledText : "Ready for message");
    },
  };
});

const scan: ScanResult = {
  language: "JavaScript", framework: "React", packageManager: "npm", runtime: null,
  services: [], monorepo: null, scripts: {}, dependencies: { prod: 0, dev: 0 }, configFiles: [],
};
const response = (text: string): IntelligenceResult => ({ response: text, level: "live", cost: 0 });
const mockedResponse = vi.mocked(intelligentResponse);

function deferred() {
  let resolve!: (result: IntelligenceResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<IntelligenceResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function requestOptions(index = 0) {
  return mockedResponse.mock.calls[index][3] as IntelligenceOptions;
}

function hookHarness(context = "Doctor results: runtime failed") {
  let chat!: ReturnType<typeof usePanelChat>;
  function Harness() {
    chat = usePanelChat({ scan, command: "doctor", context });
    return React.createElement(Text, null, chat.chatMessages.join("\n"));
  }
  const ui = render(React.createElement(Harness));
  return { ui, chat: () => chat };
}

beforeEach(() => {
  mockedResponse.mockReset();
  input.current = undefined;
  input.mounted.mockClear();
  input.unmounted.mockClear();
  input.realInput = false;
});
afterEach(cleanup);

describe("panel conversation requests", () => {
  it("admits only one coalesced send and forwards a sanitized progress label", async () => {
    const result = deferred();
    mockedResponse.mockReturnValue(result.promise);
    const { chat } = hookHarness();
    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = chat().handleChat("why did it fail?");
      duplicate = chat().handleChat("duplicate");
    });
    expect(mockedResponse).toHaveBeenCalledOnce();
    expect(chat().pending).toBe(true);
    expect(chat().chatMessages).toHaveLength(1);
    expect(chat().chatMessages[0]).not.toContain("duplicate");
    expect(requestOptions().signal).toBeInstanceOf(AbortSignal);
    act(() => { requestOptions().onProgress!("\x1b[31mWaiting for model\x1b[0m API_KEY=progress-secret"); });
    expect(chat().label).toContain("Waiting for model");
    expect(chat().label).not.toContain("progress-secret");
    expect(chat().label).not.toContain("\x1b");
    await act(async () => { result.resolve(response("Here is why.")); await first; await duplicate; });
    expect(chat().pending).toBe(false);
    expect(chat().chatMessages).toEqual(["You \u2192 why did it fail?", "AI \u2192 Here is why."]);
  });

  it("sanitizes user text, context, answers and prior turns without duplicating the current question", async () => {
    mockedResponse.mockResolvedValue(response("Try this. TOKEN=answer-secret"));
    const { chat } = hookHarness("Doctor results: PASSWORD=context-secret");
    await act(async () => { await chat().handleChat("help API_KEY=user-secret\x1b[2J"); });
    expect(mockedResponse.mock.calls[0][0]).not.toMatch(/user-secret|context-secret|\x1b/);
    expect(mockedResponse.mock.calls[0][0]).not.toContain("Doctor results");
    expect(requestOptions().directorContext).toContain("Doctor results: PASSWORD=");
    expect(requestOptions().directorContext).not.toContain("context-secret");
    expect(requestOptions().messages).toEqual([]);
    expect(chat().chatMessages.join("\n")).not.toMatch(/user-secret|answer-secret|\x1b/);
    await act(async () => { await chat().handleChat("what about that fix?"); });
    expect(requestOptions(1).messages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(requestOptions(1).messages?.[0].content).toContain("help API_KEY=");
    expect(requestOptions(1).messages?.[1].content).toContain("Try this.");
    expect(JSON.stringify(requestOptions(1).messages)).not.toMatch(/user-secret|answer-secret|context-secret|what about that fix/);
  });

  it("keeps diagnostic pattern phrases out of the query and preserves full transcript events", async () => {
    mockedResponse.mockResolvedValue(response("first line\nsecond line\nthird line\nfourth line"));
    const { chat } = hookHarness("Log: how do I start the process? what is the framework?");
    await act(async () => { await chat().handleChat("explain this failure"); });
    expect(mockedResponse.mock.calls[0][0]).toBe("explain this failure");
    expect(requestOptions().directorContext).toContain("what is the framework?");
    expect(chat().chatEvents).toEqual([
      { id: "doctor-chat-0", kind: "user", content: "explain this failure" },
      { id: "doctor-chat-1", kind: "assistant", content: "first line\nsecond line\nthird line\nfourth line" },
    ]);
  });

  it("cancels via Escape and rejects a late answer or progress without disturbing the next request", async () => {
    const old = deferred();
    const next = deferred();
    mockedResponse.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { ui, chat } = hookHarness();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = chat().handleChat("first"); });
    ui.write("\x1b");
    expect(requestOptions().signal?.aborted).toBe(true);
    expect(chat().pending).toBe(false);
    expect(chat().chatMessages.join("\n")).toContain("AI reply cancelled");
    act(() => { second = chat().handleChat("second"); });
    act(() => { requestOptions().onProgress!("stale progress"); });
    expect(chat().label).not.toContain("stale progress");
    await act(async () => { old.resolve(response("stale answer")); await first; });
    expect(chat().pending).toBe(true);
    expect(chat().chatMessages.join("\n")).not.toContain("stale answer");
    await act(async () => { next.resolve(response("current answer")); await second; });
    expect(chat().pending).toBe(false);
    expect(chat().chatMessages.at(-1)).toBe("AI \u2192 current answer");
  });

  it("shows sanitized failures, restores input readiness and permits retry", async () => {
    mockedResponse.mockRejectedValueOnce(new Error("provider rejected API_KEY=provider-secret\x1b[2J"));
    mockedResponse.mockResolvedValueOnce(response("retried"));
    const { chat } = hookHarness();
    await act(async () => { await chat().handleChat("try"); });
    expect(chat().pending).toBe(false);
    expect(chat().chatMessages.at(-1)).toContain("AI request failed");
    expect(chat().chatMessages.join("\n")).not.toMatch(/provider-secret|\x1b/);
    await act(async () => { await chat().handleChat("retry"); });
    expect(chat().chatMessages.at(-1)).toBe("AI \u2192 retried");
    expect(JSON.stringify(requestOptions(1).messages)).not.toContain("AI request failed");
  });

  it("aborts on unmount and ignores a provider that resolves anyway", async () => {
    const result = deferred();
    mockedResponse.mockReturnValue(result.promise);
    const { ui, chat } = hookHarness();
    let pending!: Promise<void>;
    act(() => { pending = chat().handleChat("question"); });
    ui.unmount();
    expect(requestOptions().signal?.aborted).toBe(true);
    await act(async () => { result.resolve(response("late after unmount")); await pending; });
    expect(chat().chatMessages.join("\n")).not.toContain("late after unmount");
  });

  it("bounds recent history and ignores empty or control-only submissions", async () => {
    mockedResponse.mockResolvedValue(response("a".repeat(4500)));
    const { chat } = hookHarness();
    await act(async () => { await chat().handleChat(" \x1b[2J "); });
    expect(mockedResponse).not.toHaveBeenCalled();
    for (let index = 0; index < 10; index++) {
      await act(async () => { await chat().handleChat(`question ${index}`); });
    }
    const messages = requestOptions(9).messages!;
    expect(messages).toHaveLength(16);
    expect(messages[0].content).toBe("question 1");
    expect(messages.every((message) => message.content.length <= 4000)).toBe(true);
    expect(chat().chatEvents).toHaveLength(20);
    expect(chat().chatEvents[1].content).toHaveLength(4500);
  });
});

describe.each(([
  ["doctor", DoctorLayout], ["start", StartLayout], ["update", UpdateLayout],
] as const).flatMap(([command, Layout]) => [
  { command, Layout, width: 80, height: 24 },
  { command, Layout, width: 150, height: 40 },
]))("$command AI input wiring at $width x $height", ({ command, Layout, width, height }) => {
  it("keeps input mounted while pending, forwards its label, cancels and remembers completed turns", async () => {
    input.width = width;
    input.height = height;
    const result = deferred();
    mockedResponse.mockReturnValueOnce(result.promise).mockResolvedValue(response("follow-up answer"));
    const ui = render(React.createElement(Layout, { scan, cwd: "/tmp/setupr-panel-test" }));
    await flushTui();
    expect(input.mounted).toHaveBeenCalledOnce();
    expect(input.current?.disabled).toBe(false);
    let first!: Promise<void>;
    act(() => { first = input.current!.onSubmit("explain this"); });
    expect(input.current?.disabled).toBe(true);
    expect(input.current?.disabledText).toContain("Preparing project context");
    act(() => { requestOptions().onProgress!("Waiting for test model"); });
    expect(input.current?.disabledText).toContain("Waiting for test model");
    expect(mockedResponse.mock.calls[0][2]).toContain(`[${command.toUpperCase()}]`);
    expect(input.mounted).toHaveBeenCalledOnce();
    expect(input.unmounted).not.toHaveBeenCalled();
    await act(async () => { result.resolve(response("first answer")); await first; });
    expect(input.current?.disabled).toBe(false);
    await act(async () => { await input.current!.onSubmit("what about that?"); });
    expect(requestOptions(1).messages).toEqual([
      { role: "user", content: "explain this" }, { role: "assistant", content: "first answer" },
    ]);
    const cancelled = deferred();
    mockedResponse.mockReturnValueOnce(cancelled.promise);
    let third!: Promise<void>;
    act(() => { third = input.current!.onSubmit("cancel me"); });
    ui.write("\x1b");
    expect(requestOptions(2).signal?.aborted).toBe(true);
    expect(input.current?.disabled).toBe(false);
    await act(async () => { cancelled.resolve(response("must not append")); await third; });
    expect(ui.lastFrame()).not.toContain("must not append");
    expect(input.mounted).toHaveBeenCalledOnce();
  });

  it("keeps every reply line reachable by page keys and mouse scroll inside a bounded panel", async () => {
    input.width = width;
    input.height = height;
    input.realInput = true;
    const answer = Array.from({ length: 24 }, (_, index) => `Reply ${String(index + 1).padStart(2, "0")}: details`).join("\n");
    mockedResponse.mockResolvedValue(response(answer));
    const element = React.createElement(Layout, { scan, cwd: "/tmp/setupr-panel-test" });
    const ui = render(element);
    Object.defineProperty(ui.stdout, "columns", { configurable: true, value: width });
    Object.defineProperty(ui.stdout, "rows", { configurable: true, value: height });
    ui.rerender(React.createElement(Layout, { scan, cwd: "/tmp/setupr-panel-test" }));
    await flushTui();
    const tabCount = command === "update" ? (width < 108 ? 3 : 4) : command === "start" && width < 110 ? 0 : 1;
    for (let index = 0; index < tabCount; index++) ui.write("\t");
    await act(async () => { await input.current!.onSubmit("explain"); });
    const initial = stripAnsi(ui.lastFrame() || "");
    expect(initial).toContain("Reply 24");
    expect(initial).not.toContain("Reply 01");
    const lines = initial.split("\n");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    const row = lines.findIndex((line) => line.includes("Reply 24"));
    const column = lines[row].indexOf("Reply 24") + 1;
    ui.write(`\x1b[<64;${column};${row + 1}M`);
    expect(ui.lastFrame()).not.toContain("Reply 24");
    const visited = [initial];
    for (let index = 0; index < 30; index++) {
      ui.write("\x1b[5~");
      visited.push(ui.lastFrame() || "");
    }
    for (let index = 0; index < 30; index++) {
      ui.write("\x1b[6~");
      visited.push(ui.lastFrame() || "");
    }
    for (let index = 1; index <= 24; index++) {
      const marker = `Reply ${String(index).padStart(2, "0")}`;
      expect(visited.some((frame) => frame.includes(marker)), `${marker} remains reachable`).toBe(true);
    }
    expect(ui.lastFrame()).toContain("Reply 24");
    expect(input.mounted).toHaveBeenCalledOnce();
    expect(input.unmounted).not.toHaveBeenCalled();
  });
});
