import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import * as executor from "../src/executor/index.js";
import { runNonTUICommand } from "../src/commands/plain/router.js";

describe("open repo uses the selected remote without a shell", () => {
  let cwd: string;
  let exitCode: typeof process.exitCode;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "setupr-open-"));
    execFileSync("git", ["init"], { cwd, stdio: "pipe" });
    exitCode = process.exitCode;
    process.exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(executor, "runCommandArgs").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });
  afterEach(async () => { vi.restoreAllMocks(); process.exitCode = exitCode; await rm(cwd, { recursive: true, force: true }); });
  function remote(name: string, url: string) { execFileSync("git", ["remote", "add", name, url], { cwd, stdio: "pipe" }); }

  it("opens an upstream-only repository", async () => {
    remote("upstream", "git@github.com:example/project.git");
    await runNonTUICommand("open", "repo", cwd, {});
    expect(executor.runCommandArgs).toHaveBeenCalledWith(expect.any(String), ["https://github.com/example/project"], cwd);
  });
  it("honors an explicit remote and removes embedded credentials", async () => {
    remote("origin", "https://github.com/example/fork.git");
    remote("upstream", "https://fixture-user:fixture-password@github.com/example/main.git");
    await runNonTUICommand("open", "repo", cwd, { remote: "upstream" });
    expect(executor.runCommandArgs).toHaveBeenCalledWith(expect.any(String), ["https://github.com/example/main"], cwd);
  });
  it("does not open a local or absent remote as a URL", async () => {
    remote("origin", "/tmp/local-repository");
    await runNonTUICommand("open", "repo", cwd, {});
    expect(executor.runCommandArgs).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
  it("reports browser launch failure instead of success", async () => {
    remote("origin", "https://github.com/example/project.git");
    vi.mocked(executor.runCommandArgs).mockResolvedValue({ exitCode: 1, stdout: "", stderr: "missing opener" });
    await runNonTUICommand("open", "repo", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).not.toContain("Opened:");
  });
});
