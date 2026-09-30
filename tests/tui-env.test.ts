import React from "react";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, flushTui } from "./helpers/tui.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvPairs } from "../src/env/index.js";
import { createAppStore } from "../src/state/store.js";
import { populateEnvVars } from "../src/tui/App.js";
import { EnvLayout } from "../src/tui/layouts/EnvLayout.js";

const directories: string[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture(env: string, example = "LABEL=\n") {
  const cwd = await mkdtemp(join(tmpdir(), "setupr-tui-env-"));
  directories.push(cwd);
  await writeFile(join(cwd, ".env"), env);
  await writeFile(join(cwd, ".env.example"), example);
  return cwd;
}

describe("env TUI integration", () => {
  it("reveals with a mouse click on the actual Show control", async () => {
    const secret = "synthetic-test-secret";
    const cwd = await fixture(`API_KEY=${secret}\n`, "API_KEY=\n");
    const ui = render(React.createElement(EnvLayout, { cwd }));
    await vi.waitFor(async () => { await flushTui(); expect(ui.lastFrame()).toContain("Show (Ctrl+R)"); });
    const lines = ui.lastFrame()!.split("\n");
    const y = lines.findIndex(line => line.includes("Show (Ctrl+R)"));
    const x = lines[y].indexOf("Show (Ctrl+R)");
    ui.write(`\x1b[<0;${x + 1};${y + 1}M`);
    await flushTui();
    expect(ui.lastFrame()).toContain(secret);
    expect(ui.lastFrame()).toContain("Hide (Ctrl+R)");
  });
  it("reveals only the editor with Ctrl+R, re-masks on focus loss, and never leaks the empty-field placeholder", async () => {
    const secret = "private-test-value-9812";
    const cwd = await fixture(`API_KEY=${secret}\n`, "API_KEY=\n");
    const ui = render(React.createElement(EnvLayout, { cwd }));
    await vi.waitFor(async () => { await flushTui(); expect(ui.lastFrame()).toContain("Show (Ctrl+R)"); });
    expect(ui.lastFrame()).not.toContain(secret);
    ui.write("\x12");
    await flushTui();
    expect(ui.lastFrame()).toContain(secret);
    expect(ui.lastFrame()).toContain("Hide (Ctrl+R)");
    ui.write("\t");
    await flushTui();
    expect(ui.lastFrame()).not.toContain(secret);
    ui.unmount();
    const second = render(React.createElement(EnvLayout, { cwd }));
    await vi.waitFor(async () => { await flushTui(); expect(second.lastFrame()).toContain("Show (Ctrl+R)"); });
    second.write("\x05\x15");
    await flushTui();
    expect(second.lastFrame()).not.toContain(secret);
  });
  it("saves a coalesced KEY=value plus Enter after the editor is ready", async () => {
    const cwd = await fixture("API_KEY=\n", "API_KEY=\n");
    const ui = render(React.createElement(EnvLayout, { cwd }));
    await vi.waitFor(async () => { await flushTui(); expect(ui.lastFrame()).toContain("EDITOR"); });
    ui.write("API_KEY=smoke-value\r");
    await vi.waitFor(async () => expect(parseEnvPairs(await readFile(join(cwd, ".env"), "utf8"))).toEqual({ API_KEY: "smoke-value" }));
  });

  it.each(["  intentional spaces  ", "   "])("saves raw selected value %j without trimming", async (value) => {
    const cwd = await fixture("LABEL=old\n");
    const ui = render(React.createElement(EnvLayout, { cwd }));
    await vi.waitFor(async () => { await flushTui(); expect(ui.lastFrame()).toContain("EDITOR"); });
    ui.write("\x05");
    ui.write("\x15");
    ui.write(value);
    ui.write("\r");
    await vi.waitFor(async () => expect(parseEnvPairs(await readFile(join(cwd, ".env"), "utf8"))).toEqual({ LABEL: value }));
  });

  it("uses shared parsing for exported keys, duplicate assignments, and multiline values", async () => {
    const cwd = await fixture(
      'export CERT="first\nFAKE=inside value\nlast"\nDUP=old\nDUP=new # comment\n',
      '  # template\nexport CERT="sample\nNOT_A_KEY=inside template\nend"\nDUP=\nDUP=\nMISSING=\n'
    );
    const store = createAppStore(cwd);
    await populateEnvVars(cwd, store);
    expect(store.getState().envVars).toEqual([
      { key: "CERT", value: "first\nFAKE=inside value\nlast", status: "auto", source: ".env" },
      { key: "DUP", value: "new", status: "auto", source: ".env" },
      { key: "MISSING", value: "", status: "pending", source: undefined },
    ]);
  });

  it("displays the system value when its status and source say system", async () => {
    const cwd = await fixture("", "SETUPR_TUI_TEST_SYSTEM=\n");
    vi.stubEnv("SETUPR_TUI_TEST_SYSTEM", "from-system");
    const store = createAppStore(cwd);
    await populateEnvVars(cwd, store);
    expect(store.getState().envVars).toEqual([
      { key: "SETUPR_TUI_TEST_SYSTEM", value: "from-system", status: "auto", source: "system" },
    ]);
  });
});
