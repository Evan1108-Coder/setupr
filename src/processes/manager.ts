import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, open, readFile, rename, unlink, writeFile, type FileHandle } from "fs/promises";
import { basename, dirname, join } from "path";
import { scanProject } from "../scanner/index.js";
import { ensureProjectStateDir } from "../state/project.js";
import { createSetuprError, fromUnknownError } from "../errors/index.js";
import { collectContext } from "../context/collector.js";
import { chooseStartPlan } from "../agent/runtime.js";
import { shellQuote } from "../util/shell.js";

export interface ManagedProcess {
  id: string;
  name: string;
  target?: string;
  command: string;
  cwd: string;
  pid?: number;
  childPid?: number;
  runId?: string;
  status: "starting" | "running" | "stopped" | "crashed";
  startedAt: number;
  stoppedAt?: number;
  exitCode?: number | null;
  autoRestart?: boolean;
  restartCount?: number;
  logFile: string;
}

const PROCESS_FILE = "processes.json";
const STARTUP_GRACE_MS = 2_000;
const STARTUP_TIMEOUT_MS = 5_000;

export async function processRegistryPath(cwd: string): Promise<string> {
  return join(await ensureProjectStateDir(cwd), PROCESS_FILE);
}

export async function processLogDir(cwd: string): Promise<string> {
  const dir = join(await ensureProjectStateDir(cwd), "logs", "processes");
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function listManagedProcesses(cwd: string): Promise<ManagedProcess[]> {
  const processes = await readRegistry(cwd);
  const refreshed = processes.map(refreshProcessStatus);
  if (JSON.stringify(processes) !== JSON.stringify(refreshed)) {
    await writeRegistry(cwd, refreshed);
  }
  return refreshed;
}

export async function startManagedProcess(
  cwd: string,
  target?: string,
  options: { force?: boolean; autoRestart?: boolean } = {}
): Promise<ManagedProcess> {
  try {
    return await startProcess(cwd, target, options);
  } catch (error) {
    throw fromUnknownError(error, { command: "start", cwd });
  }
}

async function startProcess(
  cwd: string,
  target: string | undefined,
  options: { force?: boolean; autoRestart?: boolean }
): Promise<ManagedProcess> {
  const command = await resolveStartCommand(cwd, target);
  const id = safeId(target || "dev");
  const existing = (await listManagedProcesses(cwd)).find((proc) => proc.id === id);
  const active = existing && isActiveProcess(existing);
  if (active && !options.force) {
    throw createSetuprError({
      code: "PROCESS_ALREADY_RUNNING",
      command: "start",
      cwd,
      details: [`Process ${id} is already running with PID ${existing.pid}.`],
      nextSteps: ["Run setupr ps, setupr logs, or setupr stop first. Use --force to replace it."],
    });
  }
  if (active && options.force) {
    await stopManagedProcess(cwd, id, { force: true });
  }

  const logDir = await processLogDir(cwd);
  const logFile = join(logDir, `${id}.log`);
  const entry: ManagedProcess = {
    id,
    name: target || id || basename(cwd),
    target,
    command,
    cwd,
    runId: randomUUID(),
    status: "starting",
    startedAt: Date.now(),
    autoRestart: Boolean(options.autoRestart),
    restartCount: 0,
    logFile,
  };
  // Register before spawning; only the supervisor advances this run to running/terminal.
  await upsertProcess(cwd, entry);
  let log: FileHandle | undefined;
  let supervisor: ChildProcess;
  let startup: Promise<StartupMessage>;
  try {
    log = await open(logFile, "a");
    supervisor = spawn(process.execPath, [process.argv[1], "_supervise", id, command, logFile, options.autoRestart ? "restart" : "once", entry.runId!], {
      cwd,
      detached: true,
      stdio: ["ignore", log.fd, log.fd, "ipc"],
      env: { ...process.env, SETUPR_SUPERVISOR_CWD: cwd },
    });
    startup = waitForStartup(supervisor, entry.runId!);
    supervisor.unref();
  } catch (error) {
    await updateProcessRun(cwd, entry, { status: "crashed", exitCode: 1, stoppedAt: Date.now() }).catch(() => undefined);
    throw error;
  } finally {
    await log?.close().catch(() => undefined);
  }

  const result = await startup;
  if (supervisor.connected) supervisor.disconnect();
  if (result.type === "ready" && result.entry) return result.entry;

  const current = (await readRegistry(cwd)).find(proc => proc.id === id && proc.runId === entry.runId) ?? entry;
  await shutdownProcess({ ...current, pid: supervisor.pid }, true);
  const failed = current.status === "running" || current.status === "starting"
    ? { ...current, status: "crashed" as const, stoppedAt: Date.now(), exitCode: 1, childPid: undefined }
    : current;
  await updateProcessRun(cwd, entry, failed);
  const detail = result.detail || `Process ${id} exited before startup completed.`;
  await appendLog(logFile, `[setupr] startup failed: ${detail}\n`);
  throw createSetuprError({
    code: "COMMAND_FAILED", command: "start", cwd,
    title: "Process failed to start",
    explanation: "The command did not remain running through the startup check.",
    exitCode: failed.exitCode && failed.exitCode > 0 ? failed.exitCode : 1,
    details: [detail, `Command: ${command}`, `Exit code: ${failed.exitCode ?? "unknown"}`, `Logs: ${logFile}`],
    nextSteps: [`Read the retained log with setupr logs ${id}, fix the startup failure, and retry.`],
  });
}

interface StartupMessage {
  type: "ready" | "failed";
  runId: string;
  entry?: ManagedProcess;
  detail?: string;
}

function waitForStartup(supervisor: ChildProcess, runId: string): Promise<StartupMessage> {
  return new Promise(resolve => {
    const finish = (message: StartupMessage) => {
      clearTimeout(timer);
      supervisor.off("message", onMessage);
      supervisor.off("error", onError);
      supervisor.off("exit", onExit);
      supervisor.off("disconnect", onDisconnect);
      resolve(message);
    };
    const fail = (detail: string) => finish({ type: "failed", runId, detail });
    const onMessage = (value: unknown) => {
      const message = value as StartupMessage | null;
      if (message?.runId === runId && (message.type === "ready" || message.type === "failed")) finish(message);
    };
    const onError = (error: Error) => fail(`Supervisor could not start: ${error.message}`);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => fail(`Supervisor exited before confirming startup (${signal || code}).`);
    const onDisconnect = () => fail("Supervisor disconnected before confirming startup.");
    const timer = setTimeout(() => fail(`Supervisor did not confirm startup within ${STARTUP_TIMEOUT_MS}ms.`), STARTUP_TIMEOUT_MS);
    supervisor.on("message", onMessage);
    supervisor.once("error", onError);
    supervisor.once("exit", onExit);
    supervisor.once("disconnect", onDisconnect);
  });
}

export async function stopManagedProcess(cwd: string, idOrName?: string, options: { force?: boolean } = {}): Promise<ManagedProcess[]> {
  const processes = await listManagedProcesses(cwd);
  const allTargets = !idOrName || /^(all|\*)$/i.test(idOrName);
  const targets = allTargets
    ? processes.filter(isActiveProcess)
    : processes.filter((proc) => proc.id === idOrName || proc.name === idOrName);
  const stopped: ManagedProcess[] = [];

  for (const proc of targets) {
    stopped.push({ ...proc, status: "stopped", stoppedAt: Date.now() });
  }
  await writeRegistry(cwd, mergeProcesses(processes, stopped));
  for (const proc of targets) {
    if (isActiveProcess(proc)) await shutdownProcess(proc, Boolean(options.force));
  }
  return stopped;
}

async function shutdownProcess(proc: ManagedProcess, force: boolean): Promise<void> {
  // Give the supervisor a chance to reap the child and flush logs, even for --force.
  if (proc.pid) {
    try { process.kill(proc.pid, "SIGTERM"); } catch {}
  }
  if (proc.childPid) terminateProcessTree({ pid: proc.childPid }, force ? "SIGKILL" : "SIGTERM");
  const deadline = Date.now() + 750;
  while (proc.pid && isPidRunning(proc.pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  if (proc.pid && isPidRunning(proc.pid)) {
    if (proc.childPid) terminateProcessTree({ pid: proc.childPid }, "SIGKILL");
    try { process.kill(proc.pid, "SIGKILL"); } catch {}
  }
}

export async function restartManagedProcess(cwd: string, idOrName?: string, options: { force?: boolean; autoRestart?: boolean } = {}): Promise<ManagedProcess> {
  const current = (await listManagedProcesses(cwd)).find((proc) => !idOrName || proc.id === idOrName || proc.name === idOrName);
  // Legacy dev/dev entries may be automatic; other legacy names retain script casing.
  const target = current
    ? current.target ?? (current.id === "dev" && current.name === "dev" ? undefined : current.name || current.id)
    : idOrName;
  await stopManagedProcess(cwd, current?.id || idOrName, { force: options.force });
  return startManagedProcess(cwd, target, options);
}

export async function readProcessLog(cwd: string, idOrName?: string, lines = 80): Promise<{ process?: ManagedProcess; content: string }> {
  const processes = await listManagedProcesses(cwd);
  const proc = idOrName ? processes.find((candidate) => candidate.id === idOrName || candidate.name === idOrName) : processes[0];
  if (!proc) return { content: "" };
  const content = existsSync(proc.logFile) ? await readFile(proc.logFile, "utf-8").catch(() => "") : "";
  return { process: proc, content: content.trimEnd().split(/\r?\n/).slice(-lines).join("\n") };
}

export async function runSupervisorFromCli(args: string[]): Promise<boolean> {
  if (args[0] !== "_supervise") return false;
  const [, id, command, logFile, mode, runId] = args;
  const cwd = process.env.SETUPR_SUPERVISOR_CWD || process.cwd();
  await supervisorLoop(cwd, id, command, logFile, mode === "restart", runId);
  return true;
}

async function supervisorLoop(cwd: string, id: string, command: string, logFile: string, autoRestart: boolean, runId: string): Promise<void> {
  const entry = (await readRegistry(cwd)).find(proc => proc.id === id && proc.runId === runId);
  if (!entry) return;
  let restartCount = 0;
  let stopping = false;
  let startedSuccessfully = false;
  let reported = false;
  let child: ReturnType<typeof runChild> | undefined;
  let cancelBackoff: (() => void) | undefined;
  const stop = () => {
    stopping = true;
    cancelBackoff?.();
    if (child && child.process.exitCode === null && child.process.signalCode === null) {
      const terminating = child;
      terminateProcessTree(terminating.process);
      const forceKill = setTimeout(() => terminateProcessTree(terminating.process, "SIGKILL"), 750);
      void terminating.done.then(() => clearTimeout(forceKill));
    }
  };
  const disconnected = () => { if (!reported) stop(); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("disconnect", disconnected);
  const report = async (message: StartupMessage) => {
    if (reported) return;
    reported = true;
    if (process.connected && process.send) {
      await new Promise<void>(resolve => process.send!(message, () => resolve()));
      if (process.connected) process.disconnect();
    }
  };
  try {
    await mkdir(dirname(logFile), { recursive: true });
    do {
      if (stopping) break;
      await appendLog(logFile, `\n[setupr] starting ${command}\n`);
      child = runChild(command, cwd, logFile);
      const starting = await updateProcessRun(cwd, entry, {
        status: "starting", pid: process.pid, childPid: child.process.pid, restartCount,
        exitCode: undefined, stoppedAt: undefined,
      });
      if (!starting) stop();
      let timer: NodeJS.Timeout | undefined;
      const earlyExit = await Promise.race([
        child.done,
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), STARTUP_GRACE_MS); }),
      ]);
      clearTimeout(timer);
      if (earlyExit === null && !stopping && child.process.exitCode === null && child.process.signalCode === null) {
        const running = await updateProcessRun(cwd, entry, { status: "running" });
        if (running && !stopping && child.process.exitCode === null && child.process.signalCode === null) {
          startedSuccessfully = true;
          await report({ type: "ready", runId, entry: running });
        } else if (!running) stop();
      }
      const exitCode = earlyExit ?? await child.done;
      const current = (await readRegistry(cwd)).find(proc => proc.id === id && proc.runId === runId);
      const intentionalStop = stopping || current?.status === "stopped";
      await appendLog(logFile, intentionalStop ? "[setupr] stopped\n" : `[setupr] exited with code ${exitCode}\n`);
      const next = await updateProcessRun(cwd, entry, {
        status: intentionalStop || exitCode === 0 ? "stopped" : "crashed",
        exitCode, stoppedAt: Date.now(), restartCount, childPid: undefined,
      });
      await report({ type: "failed", runId, entry: next, detail: `Process ${id} exited during startup with code ${exitCode}.` });
      if (!startedSuccessfully || intentionalStop || !next || !autoRestart || exitCode === 0) break;
      restartCount++;
      await appendLog(logFile, `[setupr] restarting (${restartCount})\n`);
      if (stopping) break;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { cancelBackoff = undefined; resolve(); }, 1000);
        cancelBackoff = () => { clearTimeout(timer); cancelBackoff = undefined; resolve(); };
      });
    } while (restartCount < 20);
  } catch (error) {
    stop();
    if (child) await child.done;
    const detail = error instanceof Error ? error.message : String(error);
    await appendLog(logFile, `[setupr] supervisor failed: ${detail}\n`).catch(() => undefined);
    const failed = await updateProcessRun(cwd, entry, {
      status: "crashed", exitCode: 1, stoppedAt: Date.now(), childPid: undefined,
    }).catch(() => undefined);
    await report({ type: "failed", runId, entry: failed, detail });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    process.off("disconnect", disconnected);
    if (process.connected) process.disconnect();
  }
}

function runChild(command: string, cwd: string, logFile: string): { process: ChildProcess; done: Promise<number> } {
  const env = { ...process.env };
  if (!env.NO_COLOR) env.FORCE_COLOR = "1";
  const child = spawn(command, { cwd, shell: true, env, detached: process.platform !== "win32" });
  let logWrites = Promise.resolve();
  const log = (value: string) => { logWrites = logWrites.then(() => appendLog(logFile, value)).catch(() => undefined); };
  const done = new Promise<number>((resolve) => {
    child.stdout?.on("data", (data) => log(data.toString()));
    child.stderr?.on("data", (data) => log(data.toString()));
    child.on("error", error => log(`[setupr] could not spawn command: ${error.message}\n`));
    child.on("close", (code) => {
      void logWrites.then(() => resolve(code ?? 1));
    });
  });
  return { process: child, done };
}

function terminateProcessTree(proc: Pick<ChildProcess, "pid">, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!proc.pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      try { process.kill(proc.pid, signal); } catch {}
    }
    return;
  }

  try {
    process.kill(-proc.pid, signal);
  } catch {
    try { process.kill(proc.pid, signal); } catch {}
  }
}

async function resolveStartCommand(cwd: string, target?: string): Promise<string> {
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  if (target) {
    if (!/^[a-zA-Z0-9:._-]+$/.test(target)) {
      throw createSetuprError({ code: "MISSING_SCRIPT", command: "start", cwd, details: [`Invalid script target: ${target}`] });
    }
    if (!scan.scripts[target]) {
      throw createSetuprError({ code: "MISSING_SCRIPT", command: "start", cwd, details: [`No script named ${target} was found.`] });
    }
    return `${shellQuote(pm)} run ${shellQuote(target)}`;
  }
  const context = await collectContext(cwd, scan).catch(() => null);
  const smart = context ? chooseStartPlan(context) : null;
  const script = smart?.script || ["dev", "start", "serve", "develop", "watch"].find((name) => scan.scripts[name]);
  if (!script) {
    throw createSetuprError({
      code: "MISSING_SCRIPT",
      command: "start",
      cwd,
      details: ["No dev, start, serve, develop, or watch script was found."],
    });
  }
  if (smart?.blockers.length) {
    // Startup can still run, but preserve the warning in the managed process log.
    const logDir = await processLogDir(cwd).catch(() => null);
    if (logDir) {
      await appendLog(join(logDir, "start-warnings.log"), `[setupr] smart start warning: ${smart.blockers.join("; ")}\n`).catch(() => undefined);
    }
  }
  return `${shellQuote(pm)} run ${shellQuote(script)}`;
}

async function readRegistry(cwd: string): Promise<ManagedProcess[]> {
  try {
    const raw = await readFile(await processRegistryPath(cwd), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isManagedProcess) : [];
  } catch {
    return [];
  }
}

async function writeRegistry(cwd: string, processes: ManagedProcess[]): Promise<void> {
  const path = await processRegistryPath(cwd);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(processes, null, 2)}\n`, "utf-8");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function updateProcessRun(cwd: string, entry: ManagedProcess, changes: Partial<ManagedProcess>): Promise<ManagedProcess | undefined> {
  const processes = await readRegistry(cwd);
  const current = processes.find(proc => proc.id === entry.id && proc.runId === entry.runId);
  if (!current || (current.status === "stopped" && (changes.status === "starting" || changes.status === "running"))) return undefined;
  const updated = { ...current, ...changes };
  await writeRegistry(cwd, mergeProcesses(processes, [updated]));
  return updated;
}

async function upsertProcess(cwd: string, processEntry: ManagedProcess): Promise<void> {
  const processes = await readRegistry(cwd);
  await writeRegistry(cwd, mergeProcesses(processes, [processEntry]));
}

function mergeProcesses(current: ManagedProcess[], updates: ManagedProcess[]): ManagedProcess[] {
  const map = new Map(current.map((proc) => [proc.id, proc]));
  for (const update of updates) map.set(update.id, update);
  return [...map.values()];
}

function refreshProcessStatus(proc: ManagedProcess): ManagedProcess {
  if ((proc.status === "running" || proc.status === "starting")
    && (proc.pid ? !isPidRunning(proc.pid) : Date.now() - proc.startedAt > STARTUP_TIMEOUT_MS)) {
    return { ...proc, status: "crashed", stoppedAt: proc.stoppedAt || Date.now() };
  }
  return proc;
}

function isActiveProcess(proc: ManagedProcess): boolean {
  return proc.status === "running" || proc.status === "starting"
    || (proc.status === "crashed" && Boolean(proc.autoRestart && proc.pid && isPidRunning(proc.pid)));
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isManagedProcess(value: unknown): value is ManagedProcess {
  const proc = value as Partial<ManagedProcess> | undefined;
  return Boolean(proc?.id && proc.command && proc.cwd && proc.logFile && proc.status);
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "dev";
}

async function appendLog(path: string, value: string): Promise<void> {
  const { appendFile } = await import("fs/promises");
  await appendFile(path, value, "utf-8");
}
