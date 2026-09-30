import React, { act } from "react";
import { Text, useInput as useInkInput, useStdin, type Key } from "ink";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globSync } from "glob";
import ts from "typescript";
import { build } from "esbuild";
import { cleanup, flushTui, render } from "./helpers/tui.js";
import { useSafeInput, useTerminalInput } from "../src/tui/terminalInput.js";
import { EnvInput } from "../src/tui/components/EnvInput.js";
import { PromptCard } from "../src/tui/components/PromptCard.js";
import { Timeline } from "../src/tui/components/Timeline.js";
import { useNavigation } from "../src/tui/hooks/useNavigation.js";
import { useFocusNavigation } from "../src/tui/hooks/useFocusNavigation.js";
import { useAiRequest } from "../src/tui/hooks/useAiRequest.js";
import { EnvLayout } from "../src/tui/layouts/EnvLayout.js";
import { ChatLayout } from "../src/tui/layouts/ChatLayout.js";
import { SetupLayout } from "../src/tui/layouts/SetupLayout.js";
import { DoctorLayout } from "../src/tui/layouts/DoctorLayout.js";
import { StartLayout } from "../src/tui/layouts/StartLayout.js";
import { UpdateLayout } from "../src/tui/layouts/UpdateLayout.js";
import { createAppStore } from "../src/state/store.js";
import { scanProject } from "../src/scanner/index.js";

// Exercise real input hooks and components, but never launch commands or AI.
vi.mock("../src/executor/index.js", () => ({ runCommand: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })) }));
vi.mock("../src/ai/intelligence.js", () => ({ intelligentResponse: vi.fn(() => { throw new Error("Unexpected AI request"); }) }));
vi.mock("../src/ai/director.js", () => ({ handleDirectorInput: vi.fn(() => { throw new Error("Unexpected AI request"); }) }));
vi.mock("../src/context/collector.js", () => ({ collectContext: vi.fn(async () => null) }));
vi.mock("../src/core/engine.js", () => ({ createProjectEngine: () => ({ history: async () => [], checkpoints: async () => ({}) }) }));

const directories: string[] = [];
afterEach(async () => {
  cleanup();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const ESC = "\x1b";
const brokenSequences = [`${ESC}[127u`, `${ESC}[8u`, `${ESC}[5u`, `${ESC}[1;5u`, `${ESC}[999;5~`];

describe("safe shared terminal input", () => {
  it.each(brokenSequences)("handles unnamed Ink key %j with multiple listeners and preserves raw bytes", async (raw) => {
    const first = vi.fn();
    const second = vi.fn();
    function Harness() {
      useTerminalInput(first);
      useTerminalInput(second);
      return React.createElement(Text, null, "ready");
    }
    const ui = render(React.createElement(Harness));
    expect(() => ui.write(raw)).not.toThrow();
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0][0]).toBe("");
    expect(first.mock.calls[0][2]).toBe(raw);
    ui.write("x");
    expect(first.mock.calls.at(-1)?.[0]).toBe("x");
    expect(ui.lastFrame()).toBe("ready");
  });

  it.each([
    "a", "A", "0", " ", "hello world", "\u65e5\u672c", "\r", "\n", "\t", "\b", "\x7f", "\x01", "\x03", "\x12", ESC,
    `${ESC}b`, `${ESC}[A`, `${ESC}[B`, `${ESC}[C`, `${ESC}[D`, `${ESC}[H`, `${ESC}[F`, `${ESC}OH`, `${ESC}OF`,
    `${ESC}[1~`, `${ESC}[4~`, `${ESC}[7~`, `${ESC}[8~`, `${ESC}[3~`, `${ESC}[5~`, `${ESC}[6~`, `${ESC}[Z`,
    `${ESC}[1;3D`, `${ESC}[1;5C`, `${ESC}${ESC}[A`, `${ESC}[3;5~`,
  ])("matches Ink's safe input/key contract for %j", (raw) => {
    const original: Array<[string, Key]> = [];
    const safe: Array<[string, Key]> = [];
    function Harness() {
      useInkInput((input, key) => original.push([input, key]));
      useTerminalInput((input, key) => safe.push([input, key]));
      return null;
    }
    const ui = render(React.createElement(Harness));
    ui.write(raw);
    expect(safe).toEqual(original);
  });

  it("does not reinterpret key-shaped chunks inside a split OSC or paste as commands", () => {
    const events: Array<[string, Key, string]> = [];
    function Harness() {
      useTerminalInput((...args) => events.push(args));
      return null;
    }
    const ui = render(React.createElement(Harness));
    for (const raw of [`${ESC}]0;`, "\x03", ESC, "\\", `${ESC}[200~`, "\r", ESC, `${ESC}[201~`]) ui.write(raw);
    expect(events.every(([, key]) => !key.escape && !key.return && !key.ctrl)).toBe(true);
    ui.write(ESC);
    expect(events.at(-1)?.[1].escape).toBe(true);
  });

  it("preserves repeated standalone Escape and complete mouse reports", () => {
    const events: Array<[string, Key, string]> = [];
    function Harness() {
      useTerminalInput((...args) => events.push(args));
      return null;
    }
    const ui = render(React.createElement(Harness));
    ui.write(ESC);
    ui.write(ESC);
    expect(events.map(([, key]) => key.escape)).toEqual([true, true]);
    ui.write(`${ESC}[<0;3;2M`);
    expect(events.at(-1)?.[0]).toBe("[<0;3;2M");
    expect(events.at(-1)?.[2]).toBe(`${ESC}[<0;3;2M`);
  });

  it("honors isActive and cleans up exactly its own raw subscription", () => {
    const calls = vi.fn();
    let emitter!: ReturnType<typeof useStdin>["internal_eventEmitter"];
    function Harness({ active }: { active: boolean }) {
      emitter = useStdin().internal_eventEmitter;
      useSafeInput(calls, { isActive: active });
      return null;
    }
    const ui = render(React.createElement(Harness, { active: false }));
    const initial = emitter.listenerCount("input");
    ui.write(`${ESC}[127u`);
    expect(calls).not.toHaveBeenCalled();
    ui.rerender(React.createElement(Harness, { active: true }));
    expect(emitter.listenerCount("input")).toBe(initial + 1);
    ui.write("a");
    ui.rerender(React.createElement(Harness, { active: true }));
    ui.write("b");
    expect(calls).toHaveBeenCalledTimes(2);
    expect(emitter.listenerCount("input")).toBe(initial + 1);
    ui.rerender(React.createElement(Harness, { active: false }));
    expect(emitter.listenerCount("input")).toBe(initial);
    ui.write("c");
    expect(calls).toHaveBeenCalledTimes(2);
    ui.rerender(React.createElement(Harness, { active: true }));
    ui.unmount();
    expect(emitter.listenerCount("input")).toBe(initial);
  });

  it.each([`${ESC}[127;3u`, `${ESC}[127;5u`, `${ESC}[127;5:2u`])("exposes modified Backspace %j without a fictitious Escape", (raw) => {
    const calls = vi.fn();
    function Harness() { useSafeInput(calls); return null; }
    const ui = render(React.createElement(Harness));
    ui.write(raw);
    expect(calls.mock.calls[0][0]).toBe("");
    expect(calls.mock.calls[0][1]).toMatchObject({ backspace: true, escape: false, ctrl: raw.includes(";5"), meta: raw.includes(";3") });
  });

  it("keeps releases, unknown reports, and byte-split CSI suffixes inert", () => {
    const calls = vi.fn();
    function Harness() { useSafeInput(calls); return null; }
    const ui = render(React.createElement(Harness));
    for (const raw of [`${ESC}[127;5:3u`, `${ESC}[127;0u`, `${ESC}[127;999u`, `${ESC}[?1;5u`, `${ESC}[12`, "7u"]) ui.write(raw);
    for (const [input, key] of calls.mock.calls) {
      expect(input).toBe("");
      expect(Object.values(key).every((value) => value === false)).toBe(true);
    }
    ui.write("normal");
    expect(calls.mock.calls.at(-1)?.[0]).toBe("normal");
  });
});

describe("real input consumers", () => {
  function Navigation() {
    const navigation = useNavigation({ panelCount: 3 });
    return React.createElement(Text, null, `panel ${navigation.activePanel}`);
  }
  function Focus() {
    const focus = useFocusNavigation({ items: [{ id: "left", row: 0, column: 0 }, { id: "right", row: 0, column: 1 }] });
    return React.createElement(Text, null, focus.activeId);
  }

  it.each(["env", "prompt", "navigation", "focus", "timeline"])("keeps %s mounted after CSI-u and subsequent ordinary input", async (kind) => {
    const onSubmit = vi.fn();
    const onSkip = vi.fn();
    const element = kind === "env"
      ? React.createElement(EnvInput, { varKey: "TEST_VALUE", remainingCount: 1, focusState: "focused", onSubmit, onSkip })
      : kind === "prompt"
        ? React.createElement(PromptCard, { title: "Answer", active: true, onSubmit })
        : kind === "navigation" ? React.createElement(Navigation)
          : kind === "focus" ? React.createElement(Focus)
            : React.createElement(Timeline, { events: [{ id: "one", kind: "assistant", content: "Line one\nLine two" }], active: true, width: 40 });
    const ui = render(element);
    await flushTui();
    for (const sequence of brokenSequences) expect(() => ui.write(sequence)).not.toThrow();
    if (kind === "env" || kind === "prompt") {
      ui.write("abcd");
      ui.write(`${ESC}[127u`);
      ui.write("\r");
      expect(onSubmit.mock.calls[0][0]).toBe("abc");
      expect(onSkip).not.toHaveBeenCalled();
    } else {
      ui.write("\t");
      expect(ui.lastFrame()).not.toContain("TypeError");
    }
  });

  it("keeps AI cancellation listening after CSI-u without treating Backspace as Escape", async () => {
    let request!: ReturnType<typeof useAiRequest>;
    let signal!: AbortSignal;
    let finish!: () => void;
    let pending!: Promise<unknown>;
    function Harness() {
      request = useAiRequest({ onError: () => {} });
      return React.createElement(Text, null, request.pending ? "pending" : "ready");
    }
    const ui = render(React.createElement(Harness));
    act(() => { pending = request.run((context) => {
      signal = context.signal;
      return new Promise<void>((resolve) => { finish = resolve; });
    }); });
    expect(() => ui.write(`${ESC}[127u`)).not.toThrow();
    expect(signal.aborted).toBe(false);
    ui.write(ESC);
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(); await pending; });
  });

  it.each(["env", "chat", "setup", "doctor", "start", "update"])("survives CSI-u with every listener in the %s screen mounted", async (kind) => {
    const cwd = await mkdtemp(join(tmpdir(), "setupr-safe-input-"));
    directories.push(cwd);
    const scan = await scanProject(cwd);
    const store = createAppStore(cwd);
    store.getState().setScan(scan);
    const element = kind === "env" ? React.createElement(EnvLayout, { cwd })
      : kind === "chat" ? React.createElement(ChatLayout, { cwd, store })
        : kind === "setup" ? React.createElement(SetupLayout, { store })
          : kind === "doctor" ? React.createElement(DoctorLayout, { cwd, scan })
            : kind === "start" ? React.createElement(StartLayout, { cwd, scan })
              : React.createElement(UpdateLayout, { cwd, scan });
    const ui = render(element);
    await flushTui();
    for (const sequence of [...brokenSequences, `${ESC}[H`, `${ESC}[F`, `${ESC}[<64;2;3M`, "\t", "."]) {
      expect(() => ui.write(sequence), `${kind}: ${JSON.stringify(sequence)}`).not.toThrow();
    }
    await flushTui();
    expect(ui.lastFrame()).not.toContain("TypeError");
    expect(ui.lastFrame()).not.toBe("");
  });
});

describe("adapter integration guards", () => {
  it("has no application imports of Ink's unsafe useInput or ink-text-input", async () => {
    const unsafe: string[] = [];
    for (const path of globSync("{src,bin}/**/*.{ts,tsx}")) {
      const file = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
      for (const statement of file.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const source = statement.moduleSpecifier.text;
        const bindings = statement.importClause?.namedBindings;
        if (source === "ink-text-input" || (source === "ink" && bindings && (
          ts.isNamespaceImport(bindings) || (ts.isNamedImports(bindings) && bindings.elements.some((element) => (element.propertyName || element.name).text === "useInput"))
        ))) unsafe.push(path);
      }
    }
    expect(unsafe).toEqual([]);
  });

  it("resolves Ink internals and handles CSI-u from built ESM in a fresh Node runtime", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".safe-input-runtime-"));
    directories.push(directory);
    const output = join(directory, "terminal-input.mjs");
    await build({ entryPoints: ["src/tui/terminalInput.ts"], outfile: output, bundle: true, packages: "external", format: "esm", platform: "node", target: "node18" });
    const code = `
      import React, { act } from "react";
      import { Text } from "ink";
      import { render, cleanup } from "ink-testing-library";
      import { useSafeInput } from ${JSON.stringify(pathToFileURL(output).href)};
      const calls = [];
      function Harness() {
        useSafeInput((input, key, raw) => calls.push({ input, key, raw }));
        return React.createElement(Text, null, "ready");
      }
      let ui;
      act(() => { ui = render(React.createElement(Harness)); });
      act(() => { ui.stdin.write("\\x1b[127u"); ui.stdin.write("x"); });
      act(() => cleanup());
      process.stdout.write(JSON.stringify(calls));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), encoding: "utf8", timeout: 10000 });
    expect(result.status, result.stderr).toBe(0);
    const calls = JSON.parse(result.stdout);
    expect(calls[0]).toMatchObject({ input: "", raw: `${ESC}[127u`, key: { backspace: true, escape: false } });
    expect(calls[1]).toMatchObject({ input: "x", raw: "x" });
  });
});
