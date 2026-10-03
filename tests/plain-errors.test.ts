import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { runNonTUICommand } from "../src/commands/plain/router.js";

describe("plain command structured errors", () => {
  let tempDir: string;
  let logs: string[];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setupr-plain-errors-"));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    process.exitCode = undefined;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("reports missing env template with the catalog code", async () => {
    await runNonTUICommand("env", "check", tempDir, {});

    expect(output()).toContain("ENV_TEMPLATE_MISSING");
    expect(process.exitCode).toBe(1);
  });

  it("reports invalid config keys with recovery details", async () => {
    await runNonTUICommand("config", "set", tempDir, { args: ["theme", "ocean"] });

    expect(output()).toContain("PROJECT_CONFIG_INVALID");
    expect(output()).toContain("Theme must be 'dark' or 'light'");
  });

  it("reports missing build scripts as structured script errors", async () => {
    await writeFile(join(tempDir, "package.json"), JSON.stringify({ scripts: { test: "node -e 0" } }));

    await runNonTUICommand("build", undefined, tempDir, {});

    expect(output()).toContain("MISSING_SCRIPT");
    expect(output()).toContain("No build script found");
  });

  it("keeps missing lock state informational but fails an explicit missing log request", async () => {
    await runNonTUICommand("diff", undefined, tempDir, {});
    expect(process.exitCode).toBeUndefined();
    await runNonTUICommand("logs", undefined, tempDir, {});

    expect(output()).toContain("LOCK_STATE_MISSING");
    expect(output()).toContain("LOG_FILE_MISSING");
    expect(process.exitCode).toBe(1);
  });

  it("asks for a package name (not an 'unknown subcommand') when add/remove get no argument", async () => {
    await runNonTUICommand("add", undefined, tempDir, {});
    expect(output()).toContain("MISSING_PACKAGE");
    expect(output()).not.toContain("UNKNOWN_SUBCOMMAND");
    expect(process.exitCode).toBe(1);

    logs = [];
    process.exitCode = undefined;
    await runNonTUICommand("remove", undefined, tempDir, {});
    expect(output()).toContain("MISSING_PACKAGE");
    expect(process.exitCode).toBe(1);
  });

  it("asks for a package name when 'deps why' gets no argument", async () => {
    await runNonTUICommand("deps", "why", tempDir, { args: [] });

    expect(output()).toContain("MISSING_PACKAGE");
    expect(output()).toContain("setupr deps why <package>");
  });

  function output(): string {
    return logs.join("\n");
  }
});
