import chalk from "chalk";
import ora from "ora";
import { scanProject } from "../scanner/index.js";
import { planSteps } from "../ai/planner.js";
import { executeAllSteps, runCommand } from "../executor/index.js";
import { createAppStore } from "../state/store.js";
import { hasProjectSignals } from "../tui/projectSignals.js";
import { createSetuprError, printPlainError, classifyCommandFailure } from "../errors/index.js";
import { deleteCheckpoint, formatCheckpointAge, loadCheckpoint, saveCheckpoint } from "../state/checkpoint.js";
import { collectDashboardStatus } from "../status/collector.js";
import { collectContext } from "../context/collector.js";
import { analyzeEnvTemplate, createPostSetupSummary, doctorInsights, formatEnvInsights } from "../agent/runtime.js";
import { deleteAgentWorkflowCheckpoint } from "../agent/workflowCheckpoint.js";
import { applyPluginPlanners, runPluginDoctorChecks } from "../plugins/runtime.js";
import { evaluateCommandSafety } from "../agent/safety.js";

interface PlainOptions {
  force?: boolean;
  fix?: boolean;
  json?: boolean;
  yes?: boolean;
  watch?: boolean;
}

export async function runPlainMode(command: string, cwd: string, sub?: string, options: PlainOptions = {}): Promise<void> {
  switch (command) {
    case "setup":
      await plainSetup(cwd, options);
      break;
    case "dashboard":
    case "status":
      await plainStatus(cwd, command === "dashboard", options);
      break;
    case "doctor":
      await plainDoctor(cwd, options);
      break;
    case "start":
      await plainStart(cwd, sub, options);
      break;
    case "update":
      await plainUpdate(cwd);
      break;
    case "clean":
      await plainClean(cwd, sub);
      break;
    default:
      printPlainError(createSetuprError({
        code: "UNKNOWN_COMMAND",
        command,
        cwd,
        details: [`Received: ${command}`],
      }));
      return;
  }
}

async function plainStatus(cwd: string, fromDashboard = false, options: PlainOptions = {}): Promise<void> {
  const status = await collectDashboardStatus(cwd);
  if (options.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(chalk.blue.bold(`\n  ${fromDashboard ? "Setupr Dashboard" : "Setupr Status"}\n`));
  console.log(`  Project:      ${chalk.white(status.projectName)}`);
  console.log(`  Directory:    ${chalk.dim(status.cwd)}`);
  console.log(`  Health:       ${healthColor(status.health.label)(status.health.score === null ? "N/A" : `${status.health.score}/100 ${status.health.label}`)}`);
  if (status.scanError) console.log(`  Scan:         ${chalk.red(status.scanError)}`);
  console.log(`  Stack:        ${chalk.white(formatStack(status))}`);
  console.log(`  Git:          ${formatGit(status)}`);
  console.log(`  Env:          ${formatEnv(status)}`);
	  console.log(`  Dependencies: ${formatDeps(status)}`);
	  console.log(`  Processes:    ${formatProcesses(status)}`);
	  console.log(`  Tests:        ${chalk.white(status.verification.status)}`);
	  console.log(`  Security:     ${securityText(status.security.score, status.security.findings)}`);
	  console.log(`  AI:           ${chalk.white(status.ai.activeModel)} ${chalk.dim(`(${status.ai.availableModels} available)`)}`);
  console.log("");
  console.log(chalk.yellow("  Checks"));
  for (const check of status.health.checks) {
    const marker = check.status === "ok" ? chalk.green("✓") : check.status === "warning" ? chalk.yellow("△") : chalk.red("✗");
    console.log(`  ${marker} ${check.label.padEnd(13)} ${chalk.dim(check.detail)}`);
  }
  if (status.history.length > 0) {
    console.log("");
    console.log(chalk.yellow("  Recent History"));
    for (const event of status.history.slice(-5)) {
      console.log(`  ${chalk.dim(formatTime(event.timestamp))} ${event.message || event.type}`);
    }
  }
  console.log("");
}

async function plainSetup(cwd: string, options: PlainOptions = {}): Promise<void> {
  if (options.force) {
    await deleteCheckpoint(cwd);
    await deleteAgentWorkflowCheckpoint(cwd);
  }
  const checkpoint = options.force ? null : await loadCheckpoint(cwd);
  let scan;
  let steps;
  let startIndex = 0;

  if (checkpoint) {
    const age = formatCheckpointAge(checkpoint.timestamp);
    const done = checkpoint.completedSteps.length;
    const total = checkpoint.steps.length;
    console.log(chalk.cyan(`\n  ↻  Resuming interrupted setup from ${age} (${done}/${total} steps done)\n`));
    scan = checkpoint.scan;
    steps = checkpoint.steps;
    startIndex = checkpoint.currentStepIndex;
  } else {
    const spinner = ora("Scanning project...").start();
    scan = await scanProject(cwd);
    spinner.succeed(`Detected: ${scan.language || "unknown"}${scan.framework ? ` / ${scan.framework}` : ""}`);
  }

  if (!hasProjectSignals(scan)) {
    printPlainError(createSetuprError({
      code: "NO_PROJECT_DETECTED",
      command: "setup",
      cwd,
      canContinue: false,
    }));
    return;
  }

  console.log(chalk.dim(`  PM: ${scan.packageManager || "none"} | Deps: ${scan.dependencies.prod} prod + ${scan.dependencies.dev} dev`));
  if (scan.services.length) console.log(chalk.dim(`  Services: ${scan.services.join(", ")}`));

  if (!steps) {
    const context = await collectContext(cwd, scan);
    const planSpinner = ora("Planning setup steps...").start();
    steps = await planSteps(scan, context);
    const pluginPlanners = await applyPluginPlanners({
      cwd,
      scan,
      projectContext: context,
      steps,
      log: (message) => console.log(chalk.dim(`  Plugin: ${message}`)),
    });
    steps = pluginPlanners.steps;
    planSpinner.succeed(`${steps.length} steps planned`);
    const appliedPlugins = pluginPlanners.diagnostics.filter((item) => item.message === "Planner applied.");
    if (appliedPlugins.length) {
      console.log(chalk.dim(`  Plugin planners: ${appliedPlugins.map((item) => item.name).join(", ")}`));
    }
    const envInsights = analyzeEnvTemplate(context);
    if (envInsights.length) {
      console.log(chalk.dim("\n  Env intelligence"));
      for (const line of formatEnvInsights(envInsights).split("\n").slice(0, 8)) console.log(chalk.dim(`  • ${line}`));
    }
  }

  const store = createAppStore(cwd);
  store.getState().setScan(scan);
  store.getState().setSteps(steps);
  const context = await collectContext(cwd, scan);
  store.getState().setContext(context);

  for (let i = 0; i < startIndex; i++) {
    const step = steps[i];
    if (step) console.log(chalk.dim(`  ○ ${step.label} (already done)`));
  }
  const result = await executeAllSteps(steps, cwd, store, startIndex);

  console.log("");
  if (result.success) {
    await deleteCheckpoint(cwd);
    console.log(createPostSetupSummary({
      context,
      steps: store.getState().steps,
      results: result.results,
      envInsights: analyzeEnvTemplate(context),
    }).split("\n").map((line) => `  ${line}`).join("\n"));
    console.log(chalk.green.bold("✓ Setup complete!"));
  } else {
    const failed = store.getState().steps.filter((step) => step.status === "failed").length || 1;
    try {
      await saveCheckpoint(cwd, {
        cwd,
        scan,
        steps: store.getState().steps,
        currentStepIndex: store.getState().currentStepIndex,
        completedSteps: store.getState().steps.filter((step) => step.status === "done").map((step) => step.id),
      });
    } catch {}
    console.log(chalk.yellow.bold(`⚠ Setup finished with ${failed} failed step${failed > 1 ? "s" : ""}`));
    console.log(chalk.dim("  Run 'setup' again to resume from where it left off."));
    process.exitCode = 1;
  }
}

async function plainDoctor(cwd: string, options: PlainOptions = {}): Promise<void> {
  const spinner = ora("Running diagnostics...").start();
  const scan = await scanProject(cwd);
  spinner.stop();

  console.log(chalk.blue.bold("\n  Setupr Doctor\n"));

  const checkedCommands = new Set<string>();

  if (scan.runtime) {
    await printVersionCheck(`${scan.runtime.name} runtime`, runtimeVersionCommands(scan.runtime.name), cwd, checkedCommands);
  }

  if (scan.packageManager) {
    await printVersionCheck(`${scan.packageManager} package manager`, packageManagerVersionCommands(scan.packageManager), cwd, checkedCommands);
  }

  console.log(chalk.dim(`\n  Language: ${scan.language || "unknown"}`));
  console.log(chalk.dim(`  Framework: ${scan.framework || "none"}`));
  if (scan.services.length) console.log(chalk.dim(`  Services: ${scan.services.join(", ")}`));
  const context = await collectContext(cwd, scan);
  const insights = doctorInsights(context);
  const pluginChecks = await runPluginDoctorChecks({
    cwd,
    scan,
    projectContext: context,
    log: (message) => console.log(chalk.dim(`  Plugin: ${message}`)),
  });
  if (insights.length) {
    console.log(chalk.yellow.bold("\n  AI Director Diagnosis\n"));
    for (const insight of insights) {
      const marker = insight.severity === "error" ? chalk.red("✗") : insight.severity === "warning" ? chalk.yellow("△") : chalk.blue("ℹ");
      console.log(`  ${marker} ${chalk.white(insight.issue)} — ${chalk.dim(insight.explanation)}`);
      if (insight.fix) {
        console.log(chalk.dim(`    Fix: ${insight.fix.label}${insight.fix.command ? ` (${insight.fix.command})` : ""}${insight.fix.safe ? " [safe]" : ""}`));
      }
    }
  }
  if (pluginChecks.length) {
    console.log(chalk.yellow.bold("\n  Plugin Checks\n"));
    for (const check of pluginChecks) {
      const marker = check.status === "pass" ? chalk.green("✓") : check.status === "warn" ? chalk.yellow("△") : chalk.red("✗");
      console.log(`  ${marker} ${chalk.white(`${check.plugin}:${check.check}`)} — ${chalk.dim(check.message)}`);
      if (check.fix) console.log(chalk.dim(`    Fix: ${check.fix.label}${check.fix.command ? ` (${check.fix.command})` : ""}`));
    }
  }

  const fixCommands = [
    ...insights
      .filter((insight) => insight.fix?.safe && insight.fix.command)
      .map((insight) => ({ label: insight.fix!.label, command: insight.fix!.command!, source: insight.issue })),
    ...pluginChecks
      .filter((check) => check.fix?.command)
      .map((check) => ({ label: check.fix!.label, command: check.fix!.command!, source: `${check.plugin}:${check.check}` })),
  ];
  if (options.fix && fixCommands.length === 0) {
    console.log(chalk.green("\n  No safe doctor fixes are available.\n"));
  } else if (options.fix && !options.yes && !options.force) {
    console.log(chalk.yellow("\n  Safe fixes are available, but were not run."));
    console.log(chalk.dim("  Re-run with: setupr doctor --plain --fix --yes"));
    for (const fix of fixCommands) console.log(chalk.dim(`  • ${fix.label}: ${fix.command}`));
    console.log("");
  } else if (options.fix) {
    console.log(chalk.yellow.bold("\n  Applying Safe Fixes\n"));
    for (const fix of fixCommands) {
      const safety = evaluateCommandSafety(fix.command);
      if (safety.decision === "block") {
        console.log(chalk.red(`  ✗ Blocked ${fix.label}: ${safety.reasons.join("; ") || "blocked by safety policy"}`));
        continue;
      }
      const result = await runCommand(fix.command, cwd);
      if (result.exitCode === 0) {
        console.log(chalk.green(`  ✓ ${fix.label}`));
      } else {
        console.log(chalk.red(`  ✗ ${fix.label}`));
        if (result.stderr.trim()) console.log(chalk.dim(`    ${result.stderr.trim().slice(0, 300)}`));
      }
    }
    console.log("");
  }
}

async function printVersionCheck(label: string, commands: string[], cwd: string, checkedCommands: Set<string>): Promise<void> {
  const candidates = commands.filter((command) => !checkedCommands.has(command));
  if (candidates.length === 0) return;

  let lastResult: Awaited<ReturnType<typeof runCommand>> | null = null;
  for (const command of candidates) {
    checkedCommands.add(command);
    const result = await runCommand(command, cwd);
    lastResult = result;
    if (result.exitCode === 0) {
      console.log(chalk.green(`  ✓ ${label}: ${firstLine(result.stdout || result.stderr)}`));
      return;
    }
  }

  const command = candidates[0];
  printPlainError(classifyCommandFailure({
    command,
    cwd,
    exitCode: lastResult?.exitCode ?? 1,
    stdout: lastResult?.stdout ?? "",
    stderr: lastResult?.stderr ?? "",
    stepLabel: label,
  }));
}

function runtimeVersionCommands(runtime: string): string[] {
  switch (runtime.toLowerCase()) {
    case "python":
      return ["python3 --version", "python --version"];
    case "rust":
      return ["rustc --version"];
    case "go":
      return ["go version"];
    default:
      return [`${runtime} --version`];
  }
}

function packageManagerVersionCommands(packageManager: string): string[] {
  switch (packageManager) {
    case "go":
      return ["go version"];
    default:
      return [`${packageManager} --version`];
  }
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] || "available";
}

async function plainStart(cwd: string, target: string | undefined, options: PlainOptions): Promise<void> {
  const { startManagedProcess } = await import("../processes/manager.js");
  try {
    const proc = await startManagedProcess(cwd, target, { force: options.force, autoRestart: options.watch });
    console.log(chalk.green(`✓ Started ${proc.id}`));
    console.log(chalk.dim(`  Command: ${proc.command}`));
    console.log(chalk.dim(`  PID: ${proc.pid || "unknown"}`));
    console.log(chalk.dim(`  Logs: ${proc.logFile}`));
    console.log(chalk.dim("  Use: setupr ps, setupr logs, setupr stop"));
  } catch (err) {
    if (typeof err === "object" && err && "code" in err) {
      printPlainError(err as any);
      return;
    }
    printPlainError(createSetuprError({
      code: "COMMAND_FAILED",
      command: "start",
      cwd,
      details: [err instanceof Error ? err.message : String(err)],
    }));
  }
}

async function plainUpdate(cwd: string): Promise<void> {
  const scan = await scanProject(cwd);
  if (!hasProjectSignals(scan)) {
    printPlainError(createSetuprError({
      code: "NO_PROJECT_DETECTED",
      command: "update",
      cwd,
      details: ["No package manifest, runtime, framework, dependency, or config files were detected."],
      nextSteps: ["Run setupr update from a project directory."],
    }));
    return;
  }
  if (!scan.packageManager) {
    printPlainError(createSetuprError({
      code: "MISSING_PACKAGE_MANAGER",
      command: "update",
      cwd,
      details: ["No supported package manager was detected for this project."],
      nextSteps: ["Add a package manifest or run a dependency-specific command."],
    }));
    return;
  }
  const pm = scan.packageManager;
  console.log(chalk.blue(`Checking outdated packages (${pm})...`));

  const result = await runCommand(`${pm} outdated`, cwd);
  if (result.exitCode > 1 || (result.exitCode !== 0 && result.stderr.trim())) {
    printPlainError(classifyCommandFailure({
      command: `${pm} outdated`,
      cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stepLabel: "Check outdated packages",
    }));
  } else if (result.stdout.trim()) {
    console.log(result.stdout);
  } else {
    console.log(chalk.green("All packages are up to date!"));
  }
}

async function plainClean(cwd: string, mode?: string): Promise<void> {
  const { rm, stat } = await import("fs/promises");
  const { join } = await import("path");

  const targets = mode === "all"
    ? ["node_modules", "dist", "build", ".next", "__pycache__", ".cache", ".env", ".env.local", ".DS_Store"]
    : mode === "share"
      ? [".env", ".env.local", ".DS_Store"]
      : ["node_modules", "__pycache__", "venv", ".venv"];

  console.log(chalk.blue("Cleaning..."));
  for (const target of targets) {
    try {
      await stat(join(cwd, target));
      await rm(join(cwd, target), { recursive: true, force: true });
      console.log(chalk.green(`  ✓ Removed ${target}`));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/ENOENT/.test(message)) {
        printPlainError(createSetuprError({
          code: "CLEAN_TARGET_FAILED",
          command: "clean",
          subcommand: mode || "deps",
          cwd,
          details: [`Target: ${target}`, message],
          canContinue: true,
        }));
      }
    }
  }
  console.log(chalk.green.bold("\n✓ Clean complete!"));
}

function formatStack(status: Awaited<ReturnType<typeof collectDashboardStatus>>): string {
  const scan = status.scan;
  if (!scan || !status.hasProject) return "no project detected";
  return [
    scan.language || "unknown",
    scan.framework,
    scan.packageManager,
    scan.runtime?.name,
  ].filter(Boolean).join(" / ");
}

function formatGit(status: Awaited<ReturnType<typeof collectDashboardStatus>>): string {
  const git = status.git;
  if (!git.isRepo) return chalk.yellow("not a git repository");
  const sync = [git.ahead ? `ahead ${git.ahead}` : "", git.behind ? `behind ${git.behind}` : ""].filter(Boolean).join(", ");
  return `${chalk.white(git.branch || "unknown")} ${git.dirtyFiles > 0 ? chalk.yellow(`${git.dirtyFiles} changed`) : chalk.green("clean")}${sync ? chalk.dim(`, ${sync}`) : ""}`;
}

function formatEnv(status: Awaited<ReturnType<typeof collectDashboardStatus>>): string {
  const env = status.env;
  if (!env.hasExample) return chalk.yellow("no .env.example");
  if (!env.hasEnv) return chalk.yellow(`${env.required} required, no .env`);
  if (env.missing.length > 0) return chalk.red(`${env.missing.length} missing of ${env.required}`);
  return chalk.green(`${env.defined}/${env.required} defined`);
}

function formatDeps(status: Awaited<ReturnType<typeof collectDashboardStatus>>): string {
  const deps = status.dependencies;
  if (!deps.manifest) return chalk.yellow("none detected");
  return `${chalk.white(`${deps.prod} prod, ${deps.dev} dev`)} ${deps.lockfilePresent ? chalk.dim(deps.lockfile) : chalk.yellow("no lockfile")}`;
}

function formatProcesses(status: Awaited<ReturnType<typeof collectDashboardStatus>>): string {
  const processes = status.processes;
  if (processes.managed === 0) return chalk.dim("none managed");
  if (processes.crashed > 0) return chalk.red(`${processes.crashed} crashed, ${processes.running}/${processes.managed} running`);
  return chalk.green(`${processes.running}/${processes.managed} running`);
}

function securityText(score: number | null, findings: number | null): string {
  if (score === null || findings === null) return chalk.dim("N/A (not assessed or unavailable)");
  const text = findings > 0 ? `${findings} finding(s), score ${score}` : `score ${score}`;
  if (score < 70) return chalk.red(text);
  if (findings > 0 || score < 90) return chalk.yellow(text);
  return chalk.green(text);
}

function healthColor(label: "good" | "warning" | "error") {
  if (label === "good") return chalk.green;
  if (label === "warning") return chalk.yellow;
  return chalk.red;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
