import React, { act } from "react";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, flushTui, render } from "./helpers/tui.js";
import { SetupLayout, buildLayout, buildFocusItems } from "../src/tui/layouts/SetupLayout.js";
import { createAppStore } from "../src/state/store.js";
import { handleDirectorInput } from "../src/ai/director.js";

const terminal = vi.hoisted(() => ({ width: 140, height: 40 }));
vi.mock("../src/tui/hooks/useTerminalSize.js", () => ({ useTerminalSize: () => terminal }));
vi.mock("../src/ai/director.js", () => ({ handleDirectorInput: vi.fn() }));

beforeEach(() => { vi.clearAllMocks(); terminal.width = 140; terminal.height = 40; });
afterEach(cleanup);

function setup() {
  const store = createAppStore("/tmp/setupr-chat-fixture");
  const scan = { language: "JavaScript", framework: "React", packageManager: "npm", runtime: { name: "node", version: "20" }, services: [], monorepo: null, scripts: { dev: "vite" }, dependencies: { prod: 2, dev: 0 }, configFiles: ["package.json"] };
  store.getState().setScan(scan);
  store.getState().setContext({ cwd: store.getState().cwd, scan, git: { isRepo: false }, envVars: { defined: [], missing: [] }, fileTree: ["package.json"], terminal: { shell: "zsh", term: "xterm-256color", platform: "darwin", nodeVersion: "20", columns: terminal.width, rows: terminal.height } });
  const ui = render(React.createElement(SetupLayout, { store }));
  const bounds = buildFocusItems(buildLayout(terminal.width, terminal.height)).find((item) => item.id === "input")!.bounds!;
  ui.write(`\x1b[<0;${bounds.x + 1};${bounds.y + 1}M`);
  return { store, ui };
}

describe("setup chat in the full layout", () => {
  it("explains an empty directory without claiming the completed scan is still loading", async () => {
    const { store, ui } = setup();
    act(() => store.setState({
      context: null,
      scan: { language: null, framework: null, packageManager: null, runtime: null, services: [], monorepo: null, scripts: {}, dependencies: { prod: 0, dev: 0 }, configFiles: [] },
    }));
    ui.write("What should I do?\r");
    await flushTui();
    expect(store.getState().messages.at(-1)?.content).toContain("No project files were detected");
    expect(store.getState().messages.at(-1)?.content).not.toContain("still loading");
    expect(handleDirectorInput).not.toHaveBeenCalled();
    ui.write("new draft");
    expect(ui.lastFrame()).toContain("new draft");
  });

  it("shows progress, prevents overlapping sends, cancels, then accepts another message", async () => {
    let signal!: AbortSignal;
    let finish!: () => void;
    vi.mocked(handleDirectorInput).mockImplementationOnce(async (request) => {
      signal = request.signal!;
      request.onProgress?.("Waiting for fixture-model");
      await new Promise<void>((resolve) => { finish = resolve; });
      signal.throwIfAborted();
      request.store.getState().addMessage({ role: "assistant", content: "Late reply must not appear" });
      return { handled: true, action: "chat" };
    });
    const { store, ui } = setup();
    ui.write("Explain the project choices\r");
    await flushTui();
    expect(handleDirectorInput).toHaveBeenCalledTimes(1);
    expect(ui.lastFrame()).toContain("Waiting for fixture-model");
    ui.write("second send\r");
    expect(handleDirectorInput).toHaveBeenCalledTimes(1);
    ui.write("\x1b");
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(); });
    expect(store.getState().messages.some((m) => m.content.includes("Late reply"))).toBe(false);
    expect(store.getState().messages.some((m) => m.content.includes("cancelled"))).toBe(true);
    vi.mocked(handleDirectorInput).mockImplementationOnce(async (request) => {
      request.store.getState().addMessage({ role: "assistant", content: "A real final answer" });
      return { handled: true, action: "chat" };
    });
    const bounds = buildFocusItems(buildLayout(terminal.width, terminal.height)).find((item) => item.id === "input")!.bounds!;
    ui.write(`\x1b[<0;${bounds.x + 1};${bounds.y + 1}M`);
    ui.write("Try again\r");
    await flushTui();
    expect(handleDirectorInput).toHaveBeenCalledTimes(2);
    expect(ui.lastFrame()).toContain("A real final answer");
  });

  it("recovers from a rejected provider without leaving the input busy", async () => {
    vi.mocked(handleDirectorInput).mockRejectedValueOnce(new Error("503 provider unavailable"));
    const { store, ui } = setup();
    ui.write("Explain the deployment\r");
    await flushTui();
    expect(store.getState().messages.at(-1)?.content).toContain("AI request failed");
    ui.write("new draft");
    expect(ui.lastFrame()).toContain("new draft");
  });

  it("keeps input and long answers within the frame after wide, narrow and tall resizes", () => {
    const { store, ui } = setup();
    act(() => store.getState().addMessage({ role: "assistant", content: "Answer details\n".repeat(80) + "Final answer line" }));
    ui.write("draft ".repeat(100));
    for (const [width, height] of [[140, 40], [80, 24], [60, 18], [200, 60], [100, 30]]) {
      terminal.width = width;
      terminal.height = height;
      ui.rerender(React.createElement(SetupLayout, { store }));
      const lines = stripAnsi(ui.lastFrame() || "").split("\n");
      expect(lines, `${width}x${height} height`).toHaveLength(height);
      expect(lines.every((line) => stringWidth(line) <= width), `${width}x${height} width`).toBe(true);
    }
  });

  it("leaves several transcript rows at a standard 80x24 terminal size", () => {
    terminal.width = 80;
    terminal.height = 24;
    const { store, ui } = setup();
    act(() => store.getState().addMessage({
      role: "assistant",
      content: "Your project uses React.\nInstall its dependencies with npm install.\nThen run npm run dev.",
    }));
    expect(ui.lastFrame()).toContain("Your project uses React.");
    expect(ui.lastFrame()).toContain("npm install");
    expect(ui.lastFrame()).toContain("npm run dev");
  });
});
