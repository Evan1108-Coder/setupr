import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { stopManagedProcess, type ManagedProcess } from "../src/processes/manager.js";

let suiteDir: string;
let cwd: string;
let cli: string;

beforeAll(async () => {
  suiteDir = await mkdtemp(join(tmpdir(), "setupr-process-startup-"));
  await symlink(resolve("node_modules"), join(suiteDir, "node_modules"), "dir");
  await writeFile(join(suiteDir, "package.json"), JSON.stringify({ name: "setupr-startup-tests", version: "1.0.0", type: "module" }));
  await build({
    config: false,
    entry: [resolve("bin/setup.ts")],
    outDir: suiteDir,
    format: ["esm"],
    target: "node18",
    splitting: false,
    silent: true,
    external: ["react-devtools-core", "yoga-wasm-web"],
  });
  cli = join(suiteDir, "setup.js");
}, 15_000);

beforeEach(async () => {
  cwd = await mkdtemp(join(suiteDir, "project-"));
});

afterEach(async () => {
  // Only terminate PIDs recorded by this fixture; failed assertions must not leak servers.
  const processes = await registry();
  for (const entry of processes) {
    const childPid = entry.childPid;
    if (childPid) {
      try { process.kill(-childPid, "SIGKILL"); } catch {}
    }
    if (entry.pid) {
      try { process.kill(entry.pid, "SIGTERM"); } catch {}
    }
  }
  const appPid = await readFile(join(cwd, "app.pid"), "utf-8").catch(() => "");
  if (appPid) {
    try { process.kill(Number(appPid), "SIGKILL"); } catch {}
  }
  await waitFor(() => processes.every(entry => !alive(entry.pid)), 500).catch(() => undefined);
  await rm(cwd, { recursive: true, force: true });
});

afterAll(async () => {
  await rm(suiteDir, { recursive: true, force: true });
});

async function fixture(source: string, script = "node app.cjs", target = "dev") {
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "startup-fixture", scripts: { [target]: script } }));
  await writeFile(join(cwd, "app.cjs"), source);
}

function runCli(...args: string[]): Promise<{ code: number; output: string }> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cli, ...args, "--cwd", cwd, "--plain"], {
      cwd,
      timeout: 5_000,
      env: { ...process.env, NO_COLOR: "1" },
    }, (error, stdout, stderr) => {
      resolveResult({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, output: stdout + stderr });
    });
  });
}

async function registry(): Promise<ManagedProcess[]> {
  try {
    return JSON.parse(await readFile(join(cwd, ".setupr/processes.json"), "utf-8"));
  } catch {
    return [];
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 1_500): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture process state");
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
}

const liveSource = `
const fs = require('fs');
fs.writeFileSync('app.pid', String(process.pid));
console.log('fixture ready');
setInterval(() => {
  if (fs.existsSync('crash-now')) { console.error('fixture later crash'); process.exit(7); }
}, 20);
`;

describe("real managed process startup", () => {
  it("fails an immediate crash and retains stderr and exit status", async () => {
    await fixture("console.error('fixture deliberate crash'); process.exit(3);\n");

    const result = await runCli("start", "--force");

    expect(result.code).toBe(3);
    expect(result.output).toContain("COMMAND_FAILED");
    expect(result.output).not.toContain("Started dev");
    const [entry] = await registry();
    expect(entry).toMatchObject({ status: "crashed", exitCode: 3 });
    expect(result.output).toContain(entry.logFile);
    expect(await readFile(entry.logFile, "utf-8")).toContain("fixture deliberate crash");
  });

  it("does not claim an empty, immediately finished program is running", async () => {
    await fixture("");

    const result = await runCli("start", "dev", "--force");

    expect(result.code).toBe(1);
    expect(result.output).toContain("COMMAND_FAILED");
    expect(result.output).not.toContain("Started dev");
    expect((await registry())[0]).toMatchObject({ status: "stopped", exitCode: 0 });
  });

  it("rejects an empty script without spawning a supervisor", async () => {
    await fixture("", "");

    const result = await runCli("start", "dev", "--force");

    expect(result.code).toBe(1);
    expect(result.output).toContain("MISSING_SCRIPT");
    expect(await registry()).toEqual([]);
  });

  it("surfaces a log-file setup failure as a nonzero structured error", async () => {
    await fixture(liveSource);
    await mkdir(join(cwd, ".setupr/logs/processes/dev.log"), { recursive: true });

    const result = await runCli("start", "dev", "--force");

    expect(result.code).toBe(1);
    expect(result.output).toContain("Code:");
    expect(result.output).not.toContain("Started dev");
    expect((await registry())[0]).toMatchObject({ status: "crashed", exitCode: 1 });
  });

  it("reports an unavailable runtime without losing its diagnostic log", async () => {
    await fixture("", "setupr_nonexistent_fixture_runtime app.cjs");

    const result = await runCli("start", "dev", "--force");

    expect(result.code).not.toBe(0);
    expect(result.output).toContain("COMMAND_FAILED");
    expect(result.output).not.toContain("Started dev");
    const [entry] = await registry();
    expect(entry.status).toBe("crashed");
    expect(await readFile(entry.logFile, "utf-8")).toContain("setupr_nonexistent_fixture_runtime");
  });

  it("fails a startup crash even in watch mode without leaving a restart loop", async () => {
    await fixture("console.error('fixture watch crash'); process.exit(3);\n");

    const result = await runCli("start", "dev", "--force", "--watch");

    expect(result.code).toBe(3);
    const [entry] = await registry();
    expect(entry).toMatchObject({ status: "crashed", exitCode: 3, restartCount: 0 });
    await waitFor(() => !alive(entry.pid));
  });

  it("starts a real long-running process and force-stops its child tree", async () => {
    await fixture(liveSource);

    const started = await runCli("start", "dev", "--force");

    expect(started.code).toBe(0);
    expect(started.output).toContain("Started dev");
    const [entry] = await registry();
    expect(entry.status).toBe("running");
    expect(alive(entry.pid)).toBe(true);
    const appPid = Number(await readFile(join(cwd, "app.pid"), "utf-8"));
    expect(alive(appPid)).toBe(true);
    expect(await readFile(entry.logFile, "utf-8")).toContain("fixture ready");

    const stopped = await runCli("stop", "dev", "--force");

    expect(stopped.code).toBe(0);
    await waitFor(() => !alive(appPid) && !alive(entry.pid));
    expect((await registry())[0].status).toBe("stopped");
  });

  it("records a later crash without replacing the already successful start result", async () => {
    await fixture(liveSource);
    const result = await runCli("start", "dev", "--force");
    expect(result.code).toBe(0);

    await writeFile(join(cwd, "crash-now"), "go");

    await waitFor(async () => (await registry())[0]?.status === "crashed");
    const [entry] = await registry();
    expect(entry.exitCode).toBe(7);
    expect(await readFile(entry.logFile, "utf-8")).toContain("fixture later crash");
  });

  it.each([
    { label: "automatic start selection", script: "start", target: undefined, legacy: false },
    { label: "case-sensitive explicit target", script: "DevServer", target: "DevServer", legacy: false },
    { label: "legacy case-sensitive name", script: "DevServer", target: "DevServer", legacy: true },
  ])("restarts using the $label rather than the normalized id", async ({ script, target, legacy }) => {
    await fixture(liveSource, "node app.cjs", script);
    expect((await runCli("start", ...(target ? [target] : []), "--force")).code).toBe(0);
    const [original] = await registry();
    const originalAppPid = Number(await readFile(join(cwd, "app.pid"), "utf-8"));
    if (legacy) {
      delete original.target;
      await writeFile(join(cwd, ".setupr/processes.json"), JSON.stringify([original]));
    }

    const restarted = await runCli("restart", original.id, "--force");

    expect(restarted.code).toBe(0);
    expect(restarted.output).toContain(`Restarted ${original.id}`);
    const entries = await registry();
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("running");
    expect(entries[0].target).toBe(target);
    expect(entries[0].runId).not.toBe(original.runId);
    expect(entries[0].pid).not.toBe(original.pid);
    expect(alive(entries[0].pid)).toBe(true);
    await waitFor(() => !alive(original.pid) && !alive(originalAppPid));
  });

  it("stops a watch supervisor during its restart delay", async () => {
    await fixture(liveSource);
    expect((await runCli("start", "dev", "--force", "--watch")).code).toBe(0);
    await writeFile(join(cwd, "crash-now"), "go");
    await waitFor(async () => (await registry())[0]?.status === "crashed");
    const [entry] = await registry();
    expect(alive(entry.pid)).toBe(true);

    await stopManagedProcess(cwd, "dev");

    await waitFor(() => !alive(entry.pid), 500);
    expect((await registry())[0].status).toBe("stopped");
  });
});
