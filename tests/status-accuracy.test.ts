import React, { act } from "react";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { collectDashboardStatus, createDashboardFallbackStatus } from "../src/status/collector.js";
import * as security from "../src/security/index.js";
import { DashboardLayout } from "../src/tui/layouts/DashboardLayout.js";
import { runPlainMode } from "../src/cli/plain.js";
import { cleanup, flushTui, render } from "./helpers/tui.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "setupr-status-accuracy-"));
  await mkdir(join(cwd, ".setupr"));
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});

describe("status accuracy", () => {
  it.each([false, true])("recognizes a zero-dependency workspace manifest (lockfile: %s)", async (lockfile) => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "workspace-root", private: true, workspaces: ["packages/*"] }));
    if (lockfile) await writeFile(join(cwd, "package-lock.json"), "{}");
    const status = await collectDashboardStatus(cwd);
    expect(status.dependencies.prod + status.dependencies.dev).toBe(0);
    expect(status.health.checks.find((check) => check.label === "Dependencies")).toMatchObject({
      status: lockfile ? "ok" : "warning", detail: expect.stringContaining("0 prod, 0 dev"),
    });
  });

  it("only reports a missing manifest when there is no manifest", async () => {
    const status = await collectDashboardStatus(cwd);
    expect(status.health.checks.find((check) => check.label === "Dependencies")?.detail).toBe("No dependency manifest detected");
  });

  it("counts the entire process registry while limiting displayed entries to eight", async () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({
      id: `process-${index}`, name: `process-${index}`, cwd, command: "fixture", startedAt: Date.now(),
      logFile: join(cwd, ".setupr", `${index}.log`),
      status: index < 9 ? "running" : index === 10 ? "stopped" : "crashed",
      pid: index < 9 ? process.pid : undefined,
    }));
    await writeFile(join(cwd, ".setupr", "processes.json"), JSON.stringify(entries));
    const status = await collectDashboardStatus(cwd);
    expect(status.processes).toMatchObject({ managed: 12, running: 9, crashed: 2 });
    expect(status.processes.entries).toHaveLength(8);
    expect(status.health.checks.find((check) => check.label === "Processes")).toMatchObject({ status: "error", detail: "2 crashed" });
  });

  it("keeps failed security collection and derived health explicitly unknown", async () => {
    vi.spyOn(security, "collectSecuritySummary").mockRejectedValue(new Error("unavailable"));
    const status = await collectDashboardStatus(cwd);
    expect(status.security).toMatchObject({ score: null, findings: null });
    expect(status.health.score).toBeNull();
    expect(status.health.checks.find((check) => check.label === "Security")).toMatchObject({ status: "warning", detail: expect.stringContaining("unavailable") });
  });

  it("does not treat the absence of security runs as a perfect score", async () => {
    const status = await collectDashboardStatus(cwd);
    expect(status.security.score).toBeNull();
    expect(status.security.findings).toBeNull();
    expect(status.health.score).toBeNull();
  });

  it.each([0, 100])("retains a measured security score of %s", async (score) => {
    await writeFile(join(cwd, ".setupr", "security-runs.json"), JSON.stringify([{ type: "security", command: "scan", cwd, createdAt: Date.now(), score, findings: [] }]));
    const status = await collectDashboardStatus(cwd);
    expect(status.security.score).toBe(score);
    expect(status.security.findings).toBe(0);
    expect(typeof status.health.score).toBe("number");
  });

  it("uses null rather than invented scores in fallback and JSON status", async () => {
    const fallback = createDashboardFallbackStatus(cwd, "probe timed out");
    expect(fallback.health.score).toBeNull();
    expect(fallback.security.score).toBeNull();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    await runPlainMode("status", cwd, undefined, { json: true });
    const status = JSON.parse(logs.join("\n"));
    expect(status.health.score).toBeNull();
    expect(status.security.score).toBeNull();
  });

  it("prints N/A for unavailable plain scores and zero counts for an existing manifest", async () => {
    await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "empty-project", private: true }));
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => logs.push(String(value)));
    await runPlainMode("status", cwd);
    const output = stripAnsi(logs.join("\n"));
    expect(output).toMatch(/Health:\s+N\/A/);
    expect(output).toMatch(/Security:\s+N\/A/);
    expect(output).toMatch(/Dependencies:\s+0 prod, 0 dev/);
    expect(output).not.toContain("No dependency manifest");
    expect(output).not.toMatch(/score 100|64\/100|null\/100/);
  });

  it.each([[80, 24], [160, 38]])("renders unavailable scores and risk as N/A at %sx%s", async (width, height) => {
    const status = createDashboardFallbackStatus(cwd, "timed out");
    const ui = render(React.createElement(DashboardLayout, { cwd, variant: "status", initialStatus: status }));
    act(() => {
      Object.defineProperty(ui.stdout, "columns", { configurable: true, value: width });
      Object.defineProperty(ui.stdout, "rows", { configurable: true, value: height });
      ui.stdout.emit("resize");
      process.stdout.emit("resize");
    });
    ui.rerender(React.createElement(DashboardLayout, { cwd, variant: "status", initialStatus: status }));
    await flushTui();
    const frame = stripAnsi(ui.lastFrame() || "");
    const lines = frame.split("\n");
    expect(lines).toHaveLength(height);
    expect(lines.every((line) => stringWidth(line) <= width)).toBe(true);
    expect(frame).toContain("N/A");
    expect(frame).toMatch(/Risk\s+N\/A/);
    expect(frame).not.toMatch(/64\/100|Low|Moderate|High|null\/100|Project state looks good/);
    expect(frame).not.toContain("█");
  });
});
