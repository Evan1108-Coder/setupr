import chalk from "chalk";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import { createProjectEngine } from "../../core/engine.js";
import { runCommand } from "../../executor/index.js";
import { createSetuprError, printPlainError } from "../../errors/index.js";
import { scanProject } from "../../scanner/index.js";
import { collectContext } from "../../context/collector.js";
import { collectDashboardStatus } from "../../status/collector.js";
import { shellQuote } from "../../util/shell.js";
import { readGitRemotes, selectGitRemote } from "../../util/gitRemote.js";

interface ProductFlags {
  args?: string[];
  json?: boolean;
  yes?: boolean;
  force?: boolean;
  report?: string;
  remote?: string;
}

export async function cmdFix(sub: string | undefined, cwd: string, flags: ProductFlags = {}): Promise<void> {
  const target = sub || "doctor";
  const plans: Record<string, string[]> = {
    doctor: ["setupr doctor --fix", "setupr env smart", "setupr test quick"],
    env: ["setupr env check", "setupr env sync"],
    lint: ["setupr lint fix"],
    format: ["setupr format run"],
    security: ["setupr security fix"],
    all: ["setupr doctor --fix", "setupr env smart", "setupr lint fix", "setupr format run", "setupr security fix", "setupr test quick"],
  };
  const commands = plans[target];
  if (!commands) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "fix",
      subcommand: target,
      cwd,
      details: ["Valid targets: doctor, env, lint, format, security, all."],
    }));
    return;
  }
  console.log(chalk.blue.bold("\n  Setupr Fix Plan\n"));
  for (const command of commands) console.log(`  ${chalk.yellow("•")} ${command}`);
  if (!flags.yes && !flags.force) {
    console.log(chalk.dim("\n  Preview only. Re-run with --yes to execute safe fix commands."));
    return;
  }
  for (const command of commands) {
    const safety = createProjectEngine({ cwd, command: "fix", subcommand: target, flags: { force: flags.force } }).evaluateShellCommand(command);
    if (safety.decision === "block") {
      console.log(chalk.red(`  Blocked: ${command}`));
      continue;
    }
    const result = await runCommand(command, cwd, (line) => console.log(line));
    if (result.exitCode !== 0) {
      console.log(chalk.yellow(`  Command exited ${result.exitCode}: ${command}`));
    }
  }
}

export async function cmdRelease(sub: string | undefined, cwd: string, flags: ProductFlags = {}): Promise<void> {
  const mode = sub || "check";
  if (mode === "check" || mode === "publish-check") {
    const report = await buildReleaseCheck(cwd);
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(chalk.blue.bold("\n  Release Check\n"));
    for (const item of report.checks) {
      const color = item.status === "ok" ? chalk.green : item.status === "warn" ? chalk.yellow : chalk.red;
      console.log(`  ${color(item.status === "ok" ? "✓" : item.status === "warn" ? "△" : "✗")} ${item.label}: ${item.detail}`);
    }
    if (mode === "publish-check") {
      console.log(chalk.dim("\n  Running npm pack --dry-run..."));
      const result = await runCommand("npm pack --dry-run", cwd, (line) => console.log(line));
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
    }
    return;
  }
  if (mode === "notes") {
    const result = await runCommand("git log --oneline -10 2>/dev/null || true", cwd);
    console.log(chalk.blue.bold("\n  Release Notes Draft\n"));
    console.log(result.stdout.trim() || "  No git history found.");
    return;
  }
  if (mode === "version") {
    const pkg = await readPackage(cwd);
    console.log(`${pkg?.name || "project"} ${pkg?.version || "0.0.0"}`);
    return;
  }
  printPlainError(createSetuprError({
    code: "UNKNOWN_SUBCOMMAND",
    command: "release",
    subcommand: mode,
    cwd,
    details: ["Valid subcommands: check, publish-check, notes, version."],
  }));
}

export async function cmdPerf(sub: string | undefined, cwd: string, flags: ProductFlags = {}): Promise<void> {
  const mode = sub || "startup";
  const started = Date.now();
  const marks: Array<{ label: string; ms: number }> = [];
  const mark = (label: string) => marks.push({ label, ms: Date.now() - started });
  if (mode === "startup" || mode === "scan") {
    await scanProject(cwd);
    mark("scan");
  }
  if (mode === "startup" || mode === "context") {
    const scan = await scanProject(cwd);
    await collectContext(cwd, scan);
    mark("context");
  }
  if (mode === "startup" || mode === "status") {
    await collectDashboardStatus(cwd);
    mark("status");
  }
  if (!marks.length) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "perf",
      subcommand: mode,
      cwd,
      details: ["Valid subcommands: startup, scan, context, status."],
    }));
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify({ mode, totalMs: Date.now() - started, marks }, null, 2));
    return;
  }
  console.log(chalk.blue.bold("\n  Performance\n"));
  for (const item of marks) console.log(`  ${item.label.padEnd(10)} ${item.ms}ms`);
  console.log(chalk.dim(`  total      ${Date.now() - started}ms`));
}

export async function cmdGithub(sub: string | undefined, cwd: string, flags: ProductFlags = {}): Promise<void> {
  const mode = sub || "status";
  const remotes = await readGitRemotes(cwd);
  const remote = selectGitRemote(remotes, flags.remote, { githubOnly: true });
  const repo = remote?.githubRepo || null;
  const data = {
    remote: remote?.url || "",
    remoteName: remote?.name || null,
    repo,
    url: repo ? `https://github.com/${repo}` : null,
    actions: repo ? `https://github.com/${repo}/actions` : null,
    pulls: repo ? `https://github.com/${repo}/pulls` : null,
    issues: repo ? `https://github.com/${repo}/issues` : null,
  };
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    if (!repo) process.exitCode = 1;
    return;
  }
  console.log(chalk.blue.bold(`\n  GitHub ${mode}\n`));
  if (!repo) {
    printPlainError(createSetuprError({
      code: "GIT_REMOTE_MISSING",
      command: "github",
      subcommand: mode,
      cwd,
      details: [flags.remote === undefined
        ? "No configured remote has a supported GitHub repository URL."
        : "The selected --remote does not exist or does not have a supported GitHub repository URL."],
    }));
    return;
  }
  console.log(`  Repo:    ${repo}`);
  console.log(`  Remote:  ${remote!.name}`);
  console.log(`  Actions: ${data.actions}`);
  console.log(`  PRs:     ${data.pulls}`);
  console.log(`  Issues:  ${data.issues}`);
}

export async function cmdRegistry(sub: string | undefined, cwd: string, flags: ProductFlags = {}): Promise<void> {
  const validRegistries = ["npm", "pypi", "crates"];
  // With no subcommand at all, guide the user to the full usage rather than
  // silently defaulting to npm and then complaining that the (missing) package
  // is an unknown subcommand.
  if (!sub) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "registry",
      cwd,
      details: ["Usage: setupr registry <npm|pypi|crates> <package>"],
    }));
    return;
  }
  // A recognized registry but no package name is a missing-argument error, not
  // an unknown subcommand.
  if (validRegistries.includes(sub) && !flags.args?.[0]) {
    printPlainError(createSetuprError({
      code: "MISSING_PACKAGE",
      command: "registry",
      subcommand: sub,
      cwd,
      details: [`Usage: setupr registry ${sub} <package>`],
    }));
    return;
  }
  const registry = sub;
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "registry",
      subcommand: registry,
      cwd,
      details: ["Usage: setupr registry <npm|pypi|crates> <package>"],
    }));
    return;
  }
  if (registry === "npm") {
    const result = await runCommand(`npm view ${shellQuote(name)} name version description license --json`, cwd);
    console.log(result.stdout.trim() || result.stderr.trim());
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  const urls: Record<string, string> = {
    pypi: `https://pypi.org/project/${encodeURIComponent(name)}/`,
    crates: `https://crates.io/crates/${encodeURIComponent(name)}`,
  };
  if (!urls[registry]) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "registry",
      subcommand: registry,
      cwd,
      details: ["Valid registries: npm, pypi, crates."],
    }));
    return;
  }
  console.log(chalk.blue.bold("\n  Registry\n"));
  console.log(`  ${name}: ${urls[registry]}`);
}

async function buildReleaseCheck(cwd: string): Promise<{ checks: Array<{ label: string; status: "ok" | "warn" | "error"; detail: string }> }> {
  const pkg = await readPackage(cwd);
  const checks: Array<{ label: string; status: "ok" | "warn" | "error"; detail: string }> = [];
  checks.push({ label: "package.json", status: pkg ? "ok" : "error", detail: pkg ? `${pkg.name || "unnamed"} ${pkg.version || "no version"}` : "missing" });
  checks.push({ label: "README", status: existsSync(join(cwd, "README.md")) ? "ok" : "warn", detail: existsSync(join(cwd, "README.md")) ? "present" : "missing" });
  checks.push({ label: "LICENSE", status: existsSync(join(cwd, "LICENSE")) ? "ok" : "warn", detail: existsSync(join(cwd, "LICENSE")) ? "present" : "missing" });
  checks.push({ label: "dist", status: existsSync(join(cwd, "dist")) ? "ok" : "warn", detail: existsSync(join(cwd, "dist")) ? "present" : "missing" });
  const git = await runCommand("git status --porcelain 2>/dev/null || true", cwd);
  checks.push({ label: "git", status: git.stdout.trim() ? "warn" : "ok", detail: git.stdout.trim() ? "working tree has changes" : "clean" });
  return { checks };
}

async function readPackage(cwd: string): Promise<{ name?: string; version?: string } | null> {
  try {
    return JSON.parse(await readFile(join(cwd, "package.json"), "utf-8")) as { name?: string; version?: string };
  } catch {
    return null;
  }
}
