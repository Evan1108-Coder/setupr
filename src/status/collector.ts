import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { runCommand, runCommandArgs } from "../executor/index.js";
import { parseEnvKeys, parseEnvPairs } from "../env/index.js";
import { getAvailableModels, getDefaultModel } from "../ai/models.js";
import { visibleCommands } from "../cli/commandRegistry.js";
import { scanProject, type ScanResult } from "../scanner/index.js";
import { hasProjectSignals } from "../tui/projectSignals.js";
import { readRecentHistoryEvents, readRecentLogEvents, readProjectState, type ProjectEvent, type JsonObject } from "../state/project.js";
import { listManagedProcesses } from "../processes/manager.js";
import { collectVerificationSummary } from "../verification/index.js";
import { collectSecuritySummary, type SecurityFinding } from "../security/index.js";
import { readGitRemotes, selectGitRemote } from "../util/gitRemote.js";

export interface DashboardStatus {
  cwd: string;
  projectName: string;
  collectedAt: number;
  scan: ScanResult | null;
  hasProject: boolean;
  scanError?: string;
  health: {
    score: number | null;
    label: "good" | "warning" | "error";
    checks: Array<{ label: string; status: "ok" | "warning" | "error"; detail: string }>;
  };
  git: {
    isRepo: boolean;
    branch?: string;
    dirtyFiles: number;
    stagedFiles: number;
    untrackedFiles: number;
    ahead?: number;
    behind?: number;
    recent: string[];
    remote?: string;
  };
  env: {
    hasExample: boolean;
    hasEnv: boolean;
    required: number;
    defined: number;
    missing: string[];
    extra: string[];
  };
  dependencies: {
    packageManager: string | null;
    manifest?: string;
    prod: number;
    dev: number;
    lockfile?: string;
    lockfilePresent: boolean;
  };
  processes: {
    managed: number;
    running: number;
    crashed: number;
    entries: Array<{ name: string; pid?: number; status: string; command?: string }>;
  };
  verification: {
    status: string;
    lastCommand?: string;
  };
  security: {
    score: number | null;
    findings: number | null;
    topFindings: SecurityFinding[];
  };
  ai: {
    activeModel: string;
    availableModels: number;
  };
  history: ProjectEvent[];
  logs: ProjectEvent[];
  commands: Array<{ name: string; summary: string }>;
}

export async function collectDashboardStatus(cwd: string): Promise<DashboardStatus> {
  const projectName = cwd.split("/").filter(Boolean).pop() || "project";
  let scan: ScanResult | null = null;
  let scanError: string | undefined;

  try {
    scan = await scanProject(cwd);
  } catch (err) {
    scanError = humanError(err);
  }

  const [git, env, processes, rawHistory, rawLogs, projectState, verificationSummary, securitySummary] = await Promise.all([
    collectGitStatus(cwd),
    collectEnvStatus(cwd),
    collectProcessStatus(cwd),
    readRecentHistoryEvents(cwd, 8),
    readRecentLogEvents(cwd, 8),
    readProjectState<JsonObject>(cwd, {}),
    collectVerificationSummary(cwd).catch(() => ({ status: "unavailable", lastRun: undefined })),
    collectSecuritySummary(cwd).catch(() => null),
  ]);

  const dependencies = collectDependencyStatus(cwd, scan);
  const hasProject = hasProjectSignals(scan);
  const verification: DashboardStatus["verification"] = {
    status: verificationSummary.status,
    lastCommand: verificationSummary.lastRun?.command,
  };
  const security: DashboardStatus["security"] = {
    score: securitySummary?.lastRun ? securitySummary.score : null,
    findings: securitySummary?.lastRun ? securitySummary.lastRun.findings.length : null,
    topFindings: securitySummary?.topFindings || [],
  };
  const health = computeHealth({ scan, scanError, hasProject, git, env, dependencies, processes, verification, security });
  const history = normalizeProjectEvents(rawHistory);
  const logs = normalizeProjectEvents(rawLogs);

  return {
    cwd,
    projectName,
    collectedAt: Date.now(),
    scan,
    hasProject,
    scanError,
    health,
    git,
    env,
    dependencies,
    processes,
    verification,
    security,
    ai: {
      activeModel: getDefaultModel().id,
      availableModels: getAvailableModels().length,
    },
    history: history.length ? history : stateHistory(projectState),
    logs,
    commands: visibleCommands()
      .filter((command) => command.name !== "help" && command.name !== "dashboard")
      .map((command) => ({ name: command.name, summary: command.summary })),
  };
}

export function createDashboardFallbackStatus(cwd: string, reason: string): DashboardStatus {
  const projectName = cwd.split("/").filter(Boolean).pop() || "project";
  return {
    cwd,
    projectName,
    collectedAt: Date.now(),
    scan: null,
    hasProject: false,
    scanError: reason,
    health: {
      score: null,
      label: "warning",
      checks: [
        { label: "Project", status: "warning", detail: "Status collection timed out" },
        { label: "Git", status: "warning", detail: "Run setupr status --plain for details" },
        { label: "Env", status: "warning", detail: "Not collected" },
        { label: "Dependencies", status: "warning", detail: "Not collected" },
        { label: "Processes", status: "warning", detail: "Not collected" },
        { label: "Security", status: "warning", detail: "Not collected" },
      ],
    },
    git: { isRepo: false, dirtyFiles: 0, stagedFiles: 0, untrackedFiles: 0, recent: [] },
    env: { hasExample: false, hasEnv: false, required: 0, defined: 0, missing: [], extra: [] },
    dependencies: { packageManager: null, prod: 0, dev: 0, lockfilePresent: false },
    processes: { managed: 0, running: 0, crashed: 0, entries: [] },
    verification: { status: "not collected" },
    security: { score: null, findings: null, topFindings: [] },
    ai: { activeModel: getDefaultModel().id, availableModels: getAvailableModels().length },
    history: [],
    logs: [],
    commands: visibleCommands()
      .filter((command) => command.name !== "help" && command.name !== "dashboard")
      .map((command) => ({ name: command.name, summary: command.summary })),
  };
}

async function collectGitStatus(cwd: string): Promise<DashboardStatus["git"]> {
  const isRepo = (await runStatusCommand("git rev-parse --is-inside-work-tree", cwd)).stdout.trim() === "true";
  if (!isRepo) {
    return { isRepo: false, dirtyFiles: 0, stagedFiles: 0, untrackedFiles: 0, recent: [] };
  }

  const [branch, remotes, status, recent] = await Promise.all([
    runStatusCommand("git branch --show-current", cwd),
    readGitRemotes(cwd),
    runStatusCommand("git status --porcelain=v1 --branch", cwd),
    runStatusCommand("git log --oneline -5", cwd),
  ]);

  let dirtyFiles = 0;
  let stagedFiles = 0;
  let untrackedFiles = 0;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (const line of status.stdout.split("\n").filter(Boolean)) {
    if (line.startsWith("##")) {
      const aheadMatch = line.match(/ahead (\d+)/);
      const behindMatch = line.match(/behind (\d+)/);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
      continue;
    }
    dirtyFiles++;
    if (line.startsWith("??")) {
      untrackedFiles++;
    } else if (line[0] !== " ") {
      stagedFiles++;
    }
  }

  return {
    isRepo: true,
    branch: branch.stdout.trim() || "detached",
    remote: selectGitRemote(remotes)?.url,
    dirtyFiles,
    stagedFiles,
    untrackedFiles,
    ahead,
    behind,
    recent: recent.stdout.split("\n").filter(Boolean).slice(0, 5),
  };
}

async function runStatusCommand(command: string, cwd: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    return await runCommand(command, cwd, undefined, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function collectEnvStatus(cwd: string): Promise<DashboardStatus["env"]> {
  const examplePath = join(cwd, ".env.example");
  const envPath = join(cwd, ".env");
  const hasExample = existsSync(examplePath);
  const hasEnv = existsSync(envPath);
  const example = hasExample ? await readFile(examplePath, "utf-8").catch(() => "") : "";
  const env = hasEnv ? await readFile(envPath, "utf-8").catch(() => "") : "";
  const required = parseEnvKeys(example);
  const defined = parseEnvKeys(env);
  const pairs = parseEnvPairs(env);
  const missing = required.filter((key) => !defined.includes(key) || !pairs[key]?.trim());
  const extra = defined.filter((key) => !required.includes(key));

  return {
    hasExample,
    hasEnv,
    required: required.length,
    defined: defined.length,
    missing,
    extra,
  };
}

function collectDependencyStatus(cwd: string, scan: ScanResult | null): DashboardStatus["dependencies"] {
  const manifest = ["package.json", "pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg", "Cargo.toml", "go.mod", "Gemfile", "composer.json", "pubspec.yaml", "mix.exs"]
    .find((file) => existsSync(join(cwd, file)));
  const lockfiles = [
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lockb",
    "poetry.lock",
    "Cargo.lock",
    "go.sum",
    "Gemfile.lock",
  ];
  const lockfile = lockfiles.find((file) => existsSync(join(cwd, file)));
  return {
    packageManager: scan?.packageManager || null,
    manifest,
    prod: scan?.dependencies.prod || 0,
    dev: scan?.dependencies.dev || 0,
    lockfile,
    lockfilePresent: Boolean(lockfile),
  };
}

async function collectProcessStatus(cwd: string): Promise<DashboardStatus["processes"]> {
  const rawProcesses = await listManagedProcesses(cwd);
  const entries = rawProcesses
    .map((entry) => ({
      name: String(entry.name || entry.id || "process"),
      pid: typeof entry.pid === "number" ? entry.pid : undefined,
      status: String(entry.status || "unknown"),
      command: typeof entry.command === "string" ? entry.command : undefined,
    }));
  return {
    managed: entries.length,
    running: entries.filter((entry) => entry.status === "running").length,
    crashed: entries.filter((entry) => entry.status === "crashed" || entry.status === "failed").length,
    entries: entries.slice(0, 8),
  };
}

function computeHealth(input: {
  scan: ScanResult | null;
  scanError?: string;
  hasProject: boolean;
  git: DashboardStatus["git"];
  env: DashboardStatus["env"];
  dependencies: DashboardStatus["dependencies"];
  processes: DashboardStatus["processes"];
  verification: DashboardStatus["verification"];
  security: DashboardStatus["security"];
}): DashboardStatus["health"] {
  const checks: DashboardStatus["health"]["checks"] = [];
  checks.push(input.hasProject
    ? { label: "Project", status: "ok", detail: `${input.scan?.language || "unknown"}${input.scan?.framework ? ` / ${input.scan.framework}` : ""}` }
    : { label: "Project", status: "warning", detail: input.scanError || "No recognizable project files detected" });
  checks.push(input.git.isRepo
    ? { label: "Git", status: input.git.dirtyFiles > 0 ? "warning" : "ok", detail: input.git.dirtyFiles > 0 ? `${input.git.dirtyFiles} changed file(s)` : `clean on ${input.git.branch || "unknown"}` }
    : { label: "Git", status: "warning", detail: "Not a git repository" });
  checks.push(input.env.hasExample
    ? { label: "Env", status: input.env.missing.length > 0 ? "error" : "ok", detail: input.env.missing.length > 0 ? `${input.env.missing.length} missing value(s)` : `${input.env.defined}/${input.env.required} values` }
    : { label: "Env", status: "warning", detail: "No .env.example" });
  checks.push(input.dependencies.manifest
    ? { label: "Dependencies", status: input.dependencies.lockfilePresent ? "ok" : "warning", detail: `${input.dependencies.prod} prod, ${input.dependencies.dev} dev${input.dependencies.lockfile ? `, ${input.dependencies.lockfile}` : ""}` }
    : { label: "Dependencies", status: "warning", detail: "No dependency manifest detected" });
  checks.push(input.processes.crashed > 0
    ? { label: "Processes", status: "error", detail: `${input.processes.crashed} crashed` }
    : { label: "Processes", status: "ok", detail: `${input.processes.running}/${input.processes.managed} running` });
  checks.push(input.verification.status.startsWith("fail")
    ? { label: "Tests", status: "error", detail: input.verification.status }
    : input.verification.status === "no test runs" || input.verification.status === "not collected"
      ? { label: "Tests", status: "warning", detail: input.verification.status }
      : { label: "Tests", status: input.verification.status.startsWith("warn") ? "warning" : "ok", detail: input.verification.status });
  checks.push(input.security.score === null
    ? { label: "Security", status: "warning", detail: "Security assessment unavailable" }
    : (input.security.findings ?? 0) > 0
      ? { label: "Security", status: input.security.score < 70 ? "error" : "warning", detail: `${input.security.findings} finding(s), score ${input.security.score}` }
      : { label: "Security", status: "ok", detail: `score ${input.security.score}` });

  const score = input.security.score === null ? null : Math.max(0, Math.round(100 - checks.reduce((total, check) => total + (check.status === "error" ? 30 : check.status === "warning" ? 12 : 0), 0)));
  const label = checks.some((check) => check.status === "error") ? "error" : checks.some((check) => check.status === "warning") ? "warning" : "good";
  return { score, label, checks };
}

function humanError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const value = err as { title?: unknown; explanation?: unknown; code?: unknown; details?: unknown } | undefined;
  const parts = [
    typeof value?.code === "string" ? value.code : "",
    typeof value?.title === "string" ? value.title : "",
    typeof value?.explanation === "string" ? value.explanation : "",
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(": ");
  return String(err);
}

function stateHistory(state: JsonObject): ProjectEvent[] {
  const raw = Array.isArray(state.history) ? state.history : [];
  return raw
    .filter((entry): entry is JsonObject => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
    .map((entry) => normalizeProjectEvent(entry))
    .filter((entry): entry is ProjectEvent => Boolean(entry))
    .slice(-8);
}

function normalizeProjectEvents(events: ProjectEvent[]): ProjectEvent[] {
  return events
    .map((event) => normalizeProjectEvent(event as unknown as JsonObject))
    .filter((event): event is ProjectEvent => Boolean(event));
}

function normalizeProjectEvent(entry: JsonObject): ProjectEvent | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const type = stringValue(entry.type)
    || (stringValue(entry.status) ? `history.${stringValue(entry.status)}` : "")
    || (stringValue(entry.command) ? "command" : "history");
  const message = stringValue(entry.message) || stringValue(entry.command) || type;

  return {
    type,
    timestamp: typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
    message,
    data: undefined,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export async function detectScriptCommand(cwd: string, names: string[]): Promise<string | null> {
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  const name = names.find((candidate) => scan.scripts[candidate]);
  if (!name) return null;
  return `${pm} run ${name}`;
}

export async function listProjectFiles(cwd: string, limit = 40): Promise<string[]> {
  const entries = await readdir(cwd, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => !["node_modules", ".git", "dist", "build"].includes(entry.name))
    .slice(0, limit)
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
}

export async function commandAvailable(command: string, cwd: string): Promise<boolean> {
  const result = await runCommandArgs(command, ["--version"], cwd);
  return result.exitCode === 0;
}
