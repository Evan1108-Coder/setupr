import meow from "meow";
import { statSync } from "fs";
import { join, resolve } from "path";
import { showPreWarning } from "./preWarning.js";
import { showTransition } from "./transition.js";
import { launchTUI } from "./launcher.js";
import { runPlainMode } from "./plain.js";
import { withInteractiveScreen } from "./terminalScreen.js";
import { helpPathFromInput, isHelpRequest, showHelp } from "./help.js";
import { createSetuprError, printPlainError } from "../errors/index.js";
import { knownCommandNames, noSubcommandNames, tuiCommandNames } from "./commandRegistry.js";
import { runSupervisorFromCli } from "../processes/manager.js";
import { createProjectEngine, redactCommandArguments, type ProjectEngine } from "../core/engine.js";
import { fileExists, initEnvFile } from "../env/index.js";

const cli = meow(
  `
  Usage
    $ setupr [command] [options]

  Commands
    dashboard   Open the project dashboard TUI
    setup       Full project setup (scan, install, configure)
    chat        Ask the AI director about the current project
    status      Show project health, git, env, process, and history status
    start       Detect and run project
    doctor      Diagnose environment health
    update      Check for dependency updates
    clean       Remove artifacts (--deps, --share, --all)

    env         Open .env editor or manage files (init, check, sync, smart)
    auth        Manage AI provider API keys and models
    info        Show project summary
    list        List available scripts/commands
    run         Run a project script
    switch      Switch runtime version
    add         Smart add dependency
    remove      Remove dependency
    port        Check/find/kill port
    deps        Dependency tree, outdated, audit
    config      Manage setupr config (show, set, reset, models)
    lock        Snapshot environment state
    diff        Compare current vs locked state
    logs        Tail project logs
    test        Run test suite
    build       Run build command
    deploy      Run deploy scripts
    open        Open in browser/IDE/repo
    fix         Preview or run grouped safe fixes
    release     Release readiness checks and npm packaging dry-runs
    perf        Measure Setupr scan/context/status performance
    github      Show GitHub repo, Actions, PR, and issue targets
    registry    Look up npm/PyPI/crates package info

    git         Git workflows (init, hooks, flow, commit, branch, pr, stash, rebase, tag, release, status, log, sync, clean)
    init        Scaffold a new project (node, python, rust, go, templates)
    migrate     Migrate package manager (npm, yarn, pnpm, bun)
    ci          Generate CI/CD config (github, gitlab, bitbucket, circleci)
    docker      Dockerfile & compose (generate, compose, check)
    secrets     Encrypted secrets management (init, set, get, list, remove, export, import, rotate)
    templates   Project templates (new, list, save, remove)
    workspace   Monorepo workspace commands (list, run, exec, add, info, check)
    health      Project health checks (full, deps, security, outdated, size)
    share       Export/import project config (export, import, inspect)
    plugin      Plugin management (install, remove, list, info, enable, disable)
    lint        Run or setup linting (run, setup, fix)
    format      Run or setup code formatting (run, check, setup)

  Options
    --force     Skip ordinary prompts; keep critical safeguards
    --all       Clean everything removable (clean only)
    --deps      Clean installed dependencies (clean only)
    --share     Clean sensitive local files for sharing (clean only)
    --tui       Prefer rich TUI output when supported
    --no-tui    Plain terminal output (alias: --plain)
    --plain     Same as --no-tui
    --help      Show help
    --version   Show version

  Examples
    $ setupr
    $ setupr dashboard
    $ setupr status --tui
    $ setupr doctor
    $ setupr auth login
    $ setupr env
    $ setupr env smart
    $ setupr chat how do I start this app?
    $ setupr release publish-check
    $ setupr perf startup
    $ setupr git flow feature my-feature
    $ setupr init --template react-app
    $ setupr ci github
    $ setupr secrets set API_KEY
    $ setupr --force
    $ setupr clean --all
`,
  {
    importMeta: import.meta,
    autoHelp: false,
    flags: {
      force: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      deps: { type: "boolean", default: false },
      share: { type: "boolean", default: false },
      noTui: { type: "boolean", default: false },
      plain: { type: "boolean", default: false },
      key: { type: "string" },
      json: { type: "boolean", default: false },
      tui: { type: "boolean", default: false },
      smart: { type: "boolean", default: false },
      dryRun: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      fix: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      watch: { type: "boolean", default: false },
      new: { type: "boolean", default: false },
      resume: { type: "boolean", default: false },
      scope: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      remote: { type: "string" },
      filter: { type: "string" },
      timeout: { type: "number" },
      report: { type: "string" },
      url: { type: "string" },
      cwd: { type: "string" },
      template: { type: "string" },
      message: { type: "string" },
    },
  }
);

export async function run() {
  const explicitCommand = cli.input[0];
  if (explicitCommand === "_supervise" && await runSupervisorFromCli(cli.input)) {
    return;
  }
  const command = explicitCommand || "dashboard";
  if (isHelpRequest(command, cli.input, Boolean(cli.flags.help))) {
    showHelp(helpPathFromInput(command, cli.input, Boolean(cli.flags.help)));
    return;
  }

  const subCommand = resolveSubCommand(command, cli.input[1], cli.flags);
  const cwd = typeof cli.flags.cwd === "string" ? resolve(cli.flags.cwd) : process.cwd();
  if (typeof cli.flags.cwd === "string" && !isExistingDirectory(cwd)) {
    printPlainError(createSetuprError({
      code: "INVALID_CWD",
      command,
      subcommand: subCommand,
      cwd,
      details: [`--cwd ${cli.flags.cwd} did not resolve to an existing directory.`],
    }));
    return;
  }
  const mode = cli.flags.plain || cli.flags.noTui ? "plain" : cli.flags.tui ? "tui" : "auto";
  const engine = createProjectEngine({
    cwd,
    command,
    subcommand: subCommand,
    args: cli.input.slice(2),
    mode,
    flags: cli.flags,
  });
  if (!validateCliRequest(command, subCommand, cwd)) return;
  if (cli.flags.tui && !process.stdout.isTTY) {
    printPlainError(createSetuprError({
      code: "TUI_RENDER_FAILED",
      command,
      subcommand: subCommand,
      cwd,
      details: ["--tui was requested, but stdout is not an interactive terminal."],
      nextSteps: ["Run in iTerm2, Ghostty, Terminal.app, or remove --tui/use --plain in CI and pipes."],
    }));
    process.exitCode = 1;
    return;
  }
  const isPlain = (cli.flags.noTui || cli.flags.plain || (command === "chat" && cli.flags.json) || !process.stdout.isTTY) && !cli.flags.tui;
  const isBareAuth = command === "auth" && !subCommand;

  await recordCommandStart(engine, cli.input);
  try {
    await runCommandPath(command, subCommand, cwd, isPlain, isBareAuth);
    await recordCommandFinish(engine);
  } catch (err) {
    await recordCommandError(engine, err);
    throw err;
  }
}

async function runCommandPath(command: string, subCommand: string | undefined, cwd: string, isPlain: boolean, isBareAuth: boolean): Promise<void> {
  const tuiCommands = tuiCommandNames();
  const isAuthSubcommand = command === "auth" && Boolean(subCommand);
  const isBareEnv = command === "env" && !subCommand;
  const isEnvSubcommand = command === "env" && Boolean(subCommand);

  if (isBareEnv && !isPlain) {
    const ready = await prepareEnvEditor(cwd, Boolean(cli.flags.force));
    if (!ready) return;
    await withInteractiveScreen(async () => {
      await showTransition(command);
      await launchTUI("env", cwd, { force: cli.flags.force });
    }, { title: "Setupr env" });
  } else if ((tuiCommands.has(command) || isBareAuth) && !isPlain && !isAuthSubcommand && !isEnvSubcommand) {
    const confirmed = await showPreWarning(command, cwd, cli.flags.force, subCommand);
    if (!confirmed) return;

    await withInteractiveScreen(async () => {
      await showTransition(command);
      await launchTUI(command as any, cwd, {
        cleanMode: subCommand as any,
        force: cli.flags.force,
        chatInitialMessage: chatInitialMessage(subCommand),
        chatStartNew: Boolean(cli.flags.new || (command === "chat" && subCommand === "start") || (command === "chat" && subCommand === "new")),
        chatResume: Boolean(cli.flags.resume || (command === "chat" && subCommand === "resume")),
      });
    }, { title: `Setupr ${command}` });
  } else if ((tuiCommands.has(command) || isBareAuth) && isPlain && !isAuthSubcommand && !isEnvSubcommand) {
    if (command === "auth") {
      const { runNonTUICommand } = await import("../commands/plain/router.js");
      await runNonTUICommand(command, subCommand, cwd, { ...cli.flags, args: cli.input.slice(2) });
      return;
    }
    if (command === "chat") {
      const { runNonTUICommand } = await import("../commands/plain/router.js");
      await runNonTUICommand(command, subCommand, cwd, { ...cli.flags, args: cli.input.slice(2) });
      return;
    }
    if (command === "env") {
      const { runNonTUICommand } = await import("../commands/plain/router.js");
      await runNonTUICommand(command, subCommand, cwd, { ...cli.flags, args: cli.input.slice(2) });
      return;
    }
    const needsConfirmation = command === "setup" || command === "clean";
    if (needsConfirmation) {
      const confirmed = await showPreWarning(command, cwd, cli.flags.force, subCommand, {
        requireConfirmation: true,
      });
      if (!confirmed) return;
    }
    await runPlainMode(command, cwd, subCommand, { force: cli.flags.force, json: cli.flags.json, watch: cli.flags.watch, fix: cli.flags.fix, yes: cli.flags.yes });
  } else {
    const { runNonTUICommand } = await import("../commands/plain/router.js");
    await runNonTUICommand(command, subCommand, cwd, { ...cli.flags, args: cli.input.slice(2) });
  }
}

async function prepareEnvEditor(cwd: string, force: boolean): Promise<boolean> {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");
  const hasEnv = await fileExists(envPath);
  const hasExample = await fileExists(examplePath);

  if (hasEnv) return true;

  if (hasExample) {
    if (!force) {
      console.log("");
      console.log("  Setupr env");
      console.log("  .env is missing. Setupr can create it from .env.example before opening the editor.");
      console.log("");
      console.log("  Press Enter to create .env and continue, Ctrl+C to cancel...");
      const confirmed = await waitForEnterBeforeEnv();
      if (!confirmed) return false;
    }
    try {
      await initEnvFile(cwd);
      console.log("  Created .env from .env.example.");
      return true;
    } catch (err) {
      printPlainError(createSetuprError({
        code: "ENV_WRITE_FAILED",
        command: "env",
        cwd,
        details: [err instanceof Error ? err.message : String(err)],
      }));
      return false;
    }
  }

  if (force) {
    try {
      await initEnvFile(cwd, { overwrite: true });
      console.log("");
      console.log("  Created empty .env because --force was used and no .env.example was found.");
      console.log("  No required variables could be inferred. Paste KEY=value lines in the editor.");
      return true;
    } catch (err) {
      printPlainError(createSetuprError({
        code: "ENV_WRITE_FAILED",
        command: "env",
        cwd,
        details: [err instanceof Error ? err.message : String(err)],
      }));
      return false;
    }
  }

  printPlainError(createSetuprError({
    code: "ENV_TEMPLATE_MISSING",
    command: "env",
    cwd,
    forceBehavior: "With --force, Setupr creates an empty .env and opens the editor, but no variables are inferred.",
  }));
  return false;
}

function waitForEnterBeforeEnv(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      printPlainError(createSetuprError({
        code: "NON_INTERACTIVE_CONFIRMATION_REQUIRED",
        command: "env",
        forceBehavior: "Pass --force to create .env without an interactive confirmation.",
      }));
      resolve(false);
      return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const key = data.toString();
      if (key === "\x03") {
        printPlainError(createSetuprError({
          code: "COMMAND_ABORTED",
          command: "env",
          details: ["Cancelled before opening the env editor."],
          exitCode: 130,
        }));
        resolve(false);
        return;
      }
      resolve(true);
    });
  });
}

function chatInitialMessage(subCommand: string | undefined): string | undefined {
  if (cli.input[0] !== "chat") return undefined;
  if (cli.flags.resume || cli.flags.new) return cli.input.slice(1).join(" ").trim() || undefined;
  if (subCommand === "resume" || subCommand === "new" || subCommand === "start") {
    const rest = cli.input.slice(2).join(" ").trim();
    return rest || undefined;
  }
  return cli.input.slice(1).join(" ").trim() || undefined;
}

function validateCliRequest(command: string, subCommand: string | undefined, cwd: string): boolean {
  const known = knownCommandNames();
  if (!known.has(command)) {
    return true;
  }

  const cleanFlags = [cli.flags.all, cli.flags.deps, cli.flags.share].filter(Boolean).length;
  if (cleanFlags > 1) {
    printPlainError(createSetuprError({
      code: "INVALID_FLAG_COMBINATION",
      command,
      cwd,
      details: ["Choose only one of --all, --deps, or --share."],
    }));
    return false;
  }
  if (command !== "clean" && cleanFlags > 0) {
    printPlainError(createSetuprError({
      code: "INVALID_FLAG",
      command,
      cwd,
      details: ["--all, --deps, and --share only apply to setup clean."],
    }));
    return false;
  }
  if (cli.flags.key && !(command === "auth" && subCommand === "set-key")) {
    printPlainError(createSetuprError({
      code: "INVALID_FLAG",
      command,
      subcommand: subCommand,
      cwd,
      details: ["--key only applies to setup auth set-key <provider>."],
    }));
    return false;
  }

  const noSubcommand = noSubcommandNames();
  if (subCommand && noSubcommand.has(command)) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command,
      subcommand: subCommand,
      cwd,
      details: [`${command} does not take a subcommand.`],
    }));
    return false;
  }
  if (command === "clean" && subCommand && !["deps", "share", "all"].includes(subCommand)) {
    printPlainError(createSetuprError({
      code: "CLEAN_MODE_INVALID",
      command: "clean",
      subcommand: subCommand,
      cwd,
    }));
    return false;
  }
  return true;
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveSubCommand(command: string, positional: string | undefined, flags: typeof cli.flags): string | undefined {
  if (command !== "clean") return positional;
  if (flags.all) return "all";
  if (flags.share) return "share";
  if (flags.deps) return "deps";
  return positional;
}

async function recordCommandStart(engine: ProjectEngine, input: string[]): Promise<void> {
  await engine.recordCommand({
    type: "command.start",
    extra: {
      args: [...input.slice(0, 2).map(maskArg), ...redactCommandArguments(input[0], input[1], input.slice(2)).map(maskArg)],
      mode: cli.flags.plain || cli.flags.noTui ? "plain" : cli.flags.tui ? "tui" : "auto",
    },
  });
}

async function recordCommandFinish(engine: ProjectEngine): Promise<void> {
  await engine.recordCommand({
    type: "command.finish",
    exitCode: numericExitCode(0),
  });
}

async function recordCommandError(engine: ProjectEngine, err: unknown): Promise<void> {
  await engine.recordCommand({
    type: "command.error",
    error: err,
    exitCode: numericExitCode(1),
  });
}

function numericExitCode(fallback: number): number {
  return typeof process.exitCode === "number" ? process.exitCode : fallback;
}

function maskArg(value: string): string {
  if (/^(sk-|sk-ant-|ghp_|github_pat_|gsk_|AIza)/.test(value)) return "****";
  if (/[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*=/i.test(value)) {
    return value.replace(/=.*/, "=****");
  }
  return value;
}
