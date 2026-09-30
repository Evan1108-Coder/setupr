import chalk from "chalk";
import { scanProject } from "../../scanner/index.js";
import { runCommand, runCommandArgs } from "../../executor/index.js";
import { readGitRemotes, selectGitRemote } from "../../util/gitRemote.js";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename, join } from "path";
import { readProjectJsonFile } from "../../scanner/projectValidation.js";
import { fileExists, initEnvFile, loadEnvEditorState, mergeEnvEditorValues, parseEnvKeys, parseEnvPairs, saveEnvEditorEntries } from "../../env/index.js";
import { createSetuprError, printPlainError, classifyCommandFailure } from "../../errors/index.js";
import { runProjectCommandOperation } from "../../core/operations.js";

interface Flags {
  force?: boolean;
  args?: string[];
  [key: string]: any;
}

export async function runNonTUICommand(
  command: string,
  sub: string | undefined,
  cwd: string,
  flags: Flags
): Promise<void> {
  switch (command) {
    case "dashboard":
    case "status": {
      const { runPlainMode } = await import("../../cli/plain.js");
      await runPlainMode(command, cwd, sub, { force: flags.force, json: Boolean(flags.json), fix: Boolean(flags.fix), yes: Boolean(flags.yes), watch: Boolean(flags.watch) });
      break;
    }
    case "env":
      await cmdEnv(sub, cwd, flags);
      break;
    case "auth": {
      const { cmdAuth } = await import("./auth.js");
      await cmdAuth(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "chat": {
      const { cmdChat } = await import("./chat.js");
      await cmdChat(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "info":
      await cmdInfo(cwd);
      break;
    case "list":
      await cmdList(cwd);
      break;
    case "run":
      await cmdRun(sub, cwd);
      break;
    case "switch":
      await cmdSwitch(sub, cwd);
      break;
    case "add":
      await cmdAdd(sub, cwd);
      break;
    case "remove":
      await cmdRemove(sub, cwd);
      break;
    case "port":
      await cmdPort(sub, cwd);
      break;
    case "deps":
      await cmdDeps(sub, cwd, flags);
      break;
    case "config":
      await cmdConfig(sub, cwd, flags);
      break;
    case "lock":
      await cmdLock(cwd);
      break;
    case "diff":
      await cmdDiff(cwd);
      break;
    case "logs":
      await cmdProcessLogs(cwd, sub);
      break;
    case "ps":
      await cmdPs(cwd, flags);
      break;
    case "stop":
      await cmdStop(cwd, sub, flags);
      break;
    case "restart":
      await cmdRestart(cwd, sub, flags);
      break;
    case "test": {
      const { runVerificationCommand } = await import("../../verification/index.js");
      await runVerificationCommand(cwd, sub || "run", { ...flags, args: flags.args || [] });
      break;
    }
    case "security": {
      const { runSecurityCommand } = await import("../../security/index.js");
      await runSecurityCommand(cwd, sub || "scan", { ...flags, args: flags.args || [] });
      break;
    }
    case "build":
      await cmdBuild(cwd);
      break;
    case "deploy":
      await cmdDeploy(cwd);
      break;
    case "open":
      await cmdOpen(sub, cwd, flags);
      break;
    case "git": {
      const { cmdGit } = await import("./git.js");
      await cmdGit(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "fix": {
      const { cmdFix } = await import("./product.js");
      await cmdFix(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "release": {
      const { cmdRelease } = await import("./product.js");
      await cmdRelease(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "perf": {
      const { cmdPerf } = await import("./product.js");
      await cmdPerf(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "github":
    case "gh": {
      const { cmdGithub } = await import("./product.js");
      await cmdGithub(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "registry": {
      const { cmdRegistry } = await import("./product.js");
      await cmdRegistry(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "init": {
      const { cmdInit } = await import("./init.js");
      await cmdInit(cwd, { ...flags, args: sub ? [sub, ...(flags.args || [])] : flags.args || [] });
      break;
    }
    case "migrate": {
      const { cmdMigrate } = await import("./migrate.js");
      await cmdMigrate(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "ci": {
      const { cmdCI } = await import("./ci.js");
      await cmdCI(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "docker": {
      const { cmdDocker } = await import("./docker.js");
      await cmdDocker(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "secrets": {
      const { cmdSecrets } = await import("./secrets.js");
      await cmdSecrets(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "templates": {
      const { cmdTemplate } = await import("./templates.js");
      await cmdTemplate(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "workspace": {
      const { cmdWorkspace } = await import("./workspace.js");
      await cmdWorkspace(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "health": {
      const { cmdHealth } = await import("./health.js");
      await cmdHealth(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "share": {
      const { cmdShare } = await import("./share.js");
      await cmdShare(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "notes": {
      const { cmdNotes } = await import("./memory.js");
      await cmdNotes(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "history": {
      const { cmdHistory } = await import("./memory.js");
      await cmdHistory(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "context": {
      const { cmdContext } = await import("./memory.js");
      await cmdContext(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "plugin": {
      const { cmdPlugin } = await import("./plugin.js");
      await cmdPlugin(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "lint": {
      const { cmdLint } = await import("./lint.js");
      await cmdLint(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "format": {
      const { cmdFormat } = await import("./format.js");
      await cmdFormat(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "scaffold": {
      const { cmdScaffold } = await import("./scaffold.js");
      await cmdScaffold(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "analyze": {
      const { cmdAnalyze } = await import("./code.js");
      await cmdAnalyze(cwd);
      break;
    }
    case "explain": {
      const { cmdExplain } = await import("./code.js");
      await cmdExplain(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "refactor": {
      const { cmdRefactor } = await import("./code.js");
      await cmdRefactor(sub, cwd, { ...flags, args: flags.args || [] });
      break;
    }
    case "todo": {
      const { cmdTodo } = await import("./code.js");
      await cmdTodo(cwd);
      break;
    }
    default: {
      const { tryRunPluginCommand } = await import("../../plugins/runtime.js");
      const handledByPlugin = await tryRunPluginCommand({
        cwd,
        command,
        args: [sub, ...(flags.args || [])].filter((item): item is string => Boolean(item)),
        log: (message) => console.log(chalk.dim(`Plugin: ${message}`)),
      });
      if (handledByPlugin) break;
      printPlainError(createSetuprError({
        code: "UNKNOWN_COMMAND",
        command,
        cwd,
        details: [`Received: ${command}`],
      }));
    }
  }
}

async function cmdEnv(sub: string | undefined, cwd: string, flags: Flags) {
  const envPath = join(cwd, ".env");
  const examplePath = join(cwd, ".env.example");

  switch (sub) {
    case undefined: {
      const hasEnv = await fileExists(envPath);
      const hasExample = await fileExists(examplePath);
      if (!hasEnv && !hasExample) {
        printPlainError(createSetuprError({
          code: "ENV_TEMPLATE_MISSING",
          command: "env",
          cwd,
          forceBehavior: "Interactive env editor mode can create an empty .env with --force, but no variables are inferred.",
        }));
        return;
      }
      if (!hasEnv && hasExample) {
        printPlainError(createSetuprError({
          code: "ENV_FILE_MISSING",
          command: "env",
          cwd,
          details: [".env.example exists, but .env has not been created yet."],
          recovery: [{ kind: "run-command", label: "Create .env from template", command: "setupr env init" }],
          canContinue: false,
        }));
        return;
      }
      const env = await readFile(envPath, "utf-8").catch(() => "");
      const example = await readFile(examplePath, "utf-8").catch(() => "");
      const currentKeys = parseEnvKeys(env);
      const requiredKeys = parseEnvKeys(example);
      const currentPairs = parseEnvPairs(env);
      const missing = requiredKeys.filter((key) => !currentKeys.includes(key) || !currentPairs[key]?.trim());
      console.log(chalk.blue.bold("\n  Setupr Env\n"));
      console.log(`  .env:          ${chalk.green("present")}`);
      console.log(`  .env.example:  ${hasExample ? chalk.green("present") : chalk.yellow("missing")}`);
      console.log(`  Values:        ${chalk.white(currentKeys.length)}`);
      if (requiredKeys.length) console.log(`  Required:      ${chalk.white(requiredKeys.length)}`);
      if (missing.length) console.log(`  Missing:       ${chalk.yellow(missing.join(", "))}`);
      console.log("");
      console.log(chalk.dim("  Run setupr env in an interactive terminal to open the editor TUI."));
      break;
    }
    case "init": {
      let result;
      try {
        result = await initEnvFile(cwd, { overwrite: flags.force });
      } catch (err) {
        printPlainError(createSetuprError({
          code: "ENV_WRITE_FAILED",
          command: "env",
          subcommand: "init",
          cwd,
          details: [err instanceof Error ? err.message : String(err)],
          forceBehavior: "Force mode can overwrite files, but it cannot write through directories, locked files, or denied permissions.",
        }));
        return;
      }
      if (result.skipped) {
        if (result.reason === "missing-example") {
          printPlainError(createSetuprError({
            code: "ENV_TEMPLATE_MISSING",
            command: "env",
            subcommand: "init",
            cwd,
            forceBehavior: "With --force, Setupr creates an empty .env and tells you no variables were inferred.",
          }));
        } else {
          printPlainError(createSetuprError({
            code: "ENV_ALREADY_EXISTS",
            command: "env",
            subcommand: "init",
            cwd,
          }));
        }
      } else if (result.source === ".env.example") {
        console.log(chalk.green("✓ Created .env from .env.example"));
      } else {
        console.log(chalk.yellow("⚠ Created empty .env because --force was used and no .env.example was found."));
        console.log(chalk.dim("  No required variables could be inferred."));
      }
      break;
    }
    case "check": {
      try {
        const example = await readFile(examplePath, "utf-8");
        const env = await readFile(envPath, "utf-8").catch(() => "");
        const required = parseEnvKeys(example);
        const defined = parseEnvKeys(env);
        const currentPairs = parseEnvPairs(env);
        const missing = required.filter((k) => !defined.includes(k) || !currentPairs[k]?.trim());
        if (missing.length === 0) {
          console.log(chalk.green("✓ All environment variables are set"));
        } else {
          printPlainError(createSetuprError({
            code: "ENV_CHECK_FAILED",
            command: "env",
            subcommand: "check",
            cwd,
            details: [`Missing ${missing.length} variable${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}`],
            canContinue: false,
          }));
        }
      } catch (err) {
        printPlainError(createSetuprError({
          code: envReadErrorCode(err),
          command: "env",
          subcommand: "check",
          cwd,
          details: [err instanceof Error ? err.message : String(err)],
          canContinue: false,
        }));
      }
      break;
    }
    case "sync": {
      try {
        const state = await loadEnvEditorState(cwd);
        if (!state.hasExample) throw new Error("Env sync requires .env.example; no files were changed.");
        await saveEnvEditorEntries(cwd, state.entries);
        console.log(chalk.green("✓ Synced missing .env.example entries while preserving existing .env data"));
      } catch (e) {
        printPlainError(createSetuprError({
          code: "ENV_SYNC_FAILED",
          command: "env",
          subcommand: "sync",
          cwd,
          details: [(e as Error).message],
        }));
      }
      break;
    }
    case "smart": {
      console.log(chalk.blue.bold("\n  🧠 Env Smart Analysis\n"));
      try {
        const state = await loadEnvEditorState(cwd);
        if (!state.hasExample) {
          throw Object.assign(new Error("Smart analysis needs .env.example to compare expected values."), { code: "ENOENT" });
        }
        const byKey = new Map(state.entries.map((entry) => [entry.key, entry]));
        const required = state.entries.filter((entry) => entry.fromTemplate);
        const currentPairs = Object.fromEntries(state.entries.filter((entry) => entry.fromEnv).map((entry) => [entry.key, entry.value]));
        const displayValue = (key: string, value: string) => byKey.get(key)?.sensitive ? "[hidden]" : JSON.stringify(value).slice(1, -1);
        const missing = required.filter((entry) => !entry.fromEnv).map((entry) => entry.key);
        const empty = required.filter((entry) => entry.fromEnv && !entry.value.trim()).map((entry) => entry.key);
        const invalid = required.filter((entry) => entry.fromEnv && entry.value.trim() && isLikelyInvalid(entry.key, entry.value)).map((entry) => entry.key);
        const changed = required.filter((entry) => entry.fromEnv && entry.templateValue?.trim() && entry.value !== entry.templateValue).map((entry) => entry.key);
        const extra = state.extra;

        if (missing.length > 0) {
          console.log(chalk.red(`  ✗ Missing (${missing.length}):`));
          missing.forEach((k) => {
            const defaultVal = byKey.get(k)?.templateValue;
            console.log(chalk.dim(`    ${k}`) + (defaultVal ? chalk.dim(` (default: ${displayValue(k, defaultVal)})`) : chalk.yellow(" — needs value")));
          });
          console.log("");
        }

        if (empty.length > 0) {
          console.log(chalk.yellow(`  ⚠ Empty/placeholder values (${empty.length}):`));
          empty.forEach((k) => console.log(chalk.dim(`    ${k}=${displayValue(k, currentPairs[k])}`)));
          console.log("");
        }

        if (invalid.length > 0) {
          console.log(chalk.yellow(`  ⚠ Possibly invalid (${invalid.length}):`));
          invalid.forEach((k) => console.log(chalk.dim(`    ${k}=${displayValue(k, currentPairs[k])}`) + chalk.yellow(` — ${getInvalidReason(k, currentPairs[k])}`)));
          console.log("");
        }

        if (extra.length > 0) {
          console.log(chalk.cyan(`  ℹ Extra vars not in .env.example (${extra.length}):`));
          extra.forEach((k) => console.log(chalk.dim(`    ${k}`)));
          console.log("");
        }

        if (changed.length > 0) {
          console.log(chalk.cyan(`  ℹ Customized from defaults (${changed.length}):`));
          changed.forEach((k) => console.log(chalk.dim(`    ${k}: ${displayValue(k, byKey.get(k)?.templateValue || "")} → ${displayValue(k, currentPairs[k])}`)));
          console.log("");
        }

        // Interactive: prompt for missing/empty/invalid values
        const needsInput = [...missing, ...empty, ...invalid];
        if (needsInput.length > 0 && process.stdin.isTTY) {
          console.log(chalk.blue.bold("  Interactive Fix\n"));
          console.log(chalk.dim("  Enter values for issues below (press Enter to skip):\n"));

          const { createInterface } = await import("readline");
          const { Writable } = await import("stream");
          const ask = (question: string, sensitive: boolean): Promise<string> => new Promise((resolve, reject) => {
            // Each value gets fresh history and editing buffers so secrets cannot be recalled later.
            const output = new Writable({
              write(chunk, _encoding, callback) {
                if (!sensitive) process.stdout.write(chunk);
                callback();
              },
            });
            const rl = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
            const onClose = () => {
              output.end();
              reject(new Error("Env input cancelled. No changes were saved."));
            };
            rl.on("SIGINT", () => rl.close());
            rl.once("close", onClose);
            if (sensitive) process.stdout.write(question);
            rl.question(sensitive ? "" : question, (answer) => {
              rl.off("close", onClose);
              rl.close();
              output.end();
              if (sensitive) process.stdout.write("\n");
              resolve(answer);
            });
          });

          for (const key of needsInput) {
            const current = currentPairs[key] || byKey.get(key)?.templateValue || "";
            const hint = current ? chalk.dim(byKey.get(key)?.sensitive ? " [hidden]" : ` [${displayValue(key, current)}]`) : "";
            const reason = invalid.includes(key) ? chalk.yellow(` (${getInvalidReason(key, currentPairs[key] || "")})`) : "";
            const answer = await ask(`  ${chalk.white(key)}${hint}${reason}: `, Boolean(byKey.get(key)?.sensitive));
            if (answer !== "") currentPairs[key] = answer;
          }
          console.log("");
        }
        const unresolved = required.filter(({ key }) => !Object.hasOwn(currentPairs, key) || !currentPairs[key].trim() || isLikelyInvalid(key, currentPairs[key]));
        if (unresolved.length > 0) {
          printPlainError(createSetuprError({
            code: "ENV_SMART_FAILED",
            command: "env",
            subcommand: "smart",
            cwd,
            details: [`Unresolved variables: ${unresolved.map((entry) => entry.key).join(", ")}. No changes were saved.`, "Run interactively in a TTY to fix, or manually edit .env."],
            canContinue: false,
          }));
          return;
        }

        await saveEnvEditorEntries(cwd, mergeEnvEditorValues(state.entries, currentPairs));
        console.log(chalk.green("  ✓ Saved .env; all required variables are filled and passed basic validation"));
      } catch (err) {
        printPlainError(createSetuprError({
          code: (err as NodeJS.ErrnoException).code === "ENOENT" ? "ENV_TEMPLATE_MISSING" : "ENV_SMART_FAILED",
          command: "env",
          subcommand: "smart",
          cwd,
          details: [err instanceof Error ? err.message : "Could not safely update .env."],
        }));
      }
      break;
    }
    default:
      printPlainError(createSetuprError({
        code: "UNKNOWN_SUBCOMMAND",
        command: "env",
        subcommand: sub,
        cwd,
        details: ["Valid subcommands: init, check, sync, smart."],
      }));
  }
}

async function cmdInfo(cwd: string) {
  const scan = await scanProject(cwd);
  const manifest = await readProjectJsonFile(cwd, "package.json");
  const projectName = typeof manifest?.name === "string" && manifest.name.trim() ? manifest.name : basename(cwd);
  console.log(chalk.blue.bold("\n  Project Info\n"));
  console.log(`  Project:     ${chalk.white(projectName)}`);
  console.log(`  Directory:   ${chalk.white(cwd)}`);
  console.log(`  Language:    ${chalk.white(scan.language || "unknown")}`);
  console.log(`  Framework:   ${chalk.white(scan.framework || "none")}`);
  console.log(`  PM:          ${chalk.white(scan.packageManager || "none")}`);
  console.log(`  Runtime:     ${chalk.white(scan.runtime ? `${scan.runtime.name}${scan.runtime.version ? ` ${scan.runtime.version}` : ""}` : "none")}`);
  console.log(`  Deps:        ${chalk.white(`${scan.dependencies.prod} prod + ${scan.dependencies.dev} dev`)}`);
  if (scan.services.length) console.log(`  Services:    ${chalk.white(scan.services.join(", "))}`);
  if (scan.monorepo) console.log(`  Monorepo:    ${chalk.white(`${scan.monorepo.type} (${scan.monorepo.packages.length} packages)`)}`);
  console.log(`  Configs:     ${chalk.dim(scan.configFiles.join(", "))}`);
  console.log("");
}

async function cmdList(cwd: string) {
  const scan = await scanProject(cwd);
  if (Object.keys(scan.scripts).length === 0) {
    console.log(chalk.dim("No scripts found."));
    return;
  }
  console.log(chalk.blue.bold("\n  Available Scripts\n"));
  for (const [name, cmd] of Object.entries(scan.scripts)) {
    console.log(`  ${chalk.green(name.padEnd(15))} ${chalk.dim(cmd)}`);
  }
  console.log("");
}

async function cmdRun(script: string | undefined, cwd: string) {
  if (!script) {
    printPlainError(createSetuprError({ code: "MISSING_SCRIPT", command: "run", cwd, details: ["Usage: setup run <script>"] }));
    return;
  }
  if (!/^[a-zA-Z0-9:._-]+$/.test(script)) {
    printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "run", cwd, details: [`Invalid script name: ${script}`] }));
    return;
  }
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  const cmd = `${pm} run ${script}`;
  await runPlainCommand(cmd, cwd, { stepType: "script", stepLabel: script });
}

async function cmdSwitch(version: string | undefined, cwd: string) {
  if (!version) {
    printPlainError(createSetuprError({ code: "MISSING_RUNTIME", command: "switch", cwd, details: ["Usage: setup switch <version>"] }));
    return;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(version)) {
    printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "switch", cwd, details: [`Invalid version format: ${version}`] }));
    return;
  }
  console.log(chalk.blue(`Switching to version: ${version}`));
  const result = await runCommand(`nvm use ${version} 2>/dev/null || fnm use ${version} 2>/dev/null || echo "Use 'nvm install ${version}' first"`, cwd);
  console.log(result.stdout || result.stderr);
}

async function cmdAdd(pkg: string | undefined, cwd: string) {
  if (!pkg) {
    printPlainError(createSetuprError({ code: "MISSING_PACKAGE", command: "add", cwd, details: ["Usage: setup add <package>"] }));
    return;
  }
  if (!/^[@a-zA-Z0-9/_.-]+$/.test(pkg)) {
    printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "add", cwd, details: [`Invalid package name: ${pkg}`] }));
    return;
  }
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  const cmds: Record<string, string> = { npm: "npm install", yarn: "yarn add", pnpm: "pnpm add", bun: "bun add" };
  const cmd = `${cmds[pm] || `${pm} install`} ${pkg}`;
  await runPlainCommand(cmd, cwd, { stepType: "deps", stepLabel: `Add ${pkg}` });
}

async function cmdRemove(pkg: string | undefined, cwd: string) {
  if (!pkg) {
    printPlainError(createSetuprError({ code: "MISSING_PACKAGE", command: "remove", cwd, details: ["Usage: setup remove <package>"] }));
    return;
  }
  if (!/^[@a-zA-Z0-9/_.-]+$/.test(pkg)) {
    printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "remove", cwd, details: [`Invalid package name: ${pkg}`] }));
    return;
  }
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  const cmds: Record<string, string> = { npm: "npm uninstall", yarn: "yarn remove", pnpm: "pnpm remove", bun: "bun remove" };
  const cmd = `${cmds[pm] || `${pm} remove`} ${pkg}`;
  await runPlainCommand(cmd, cwd, { stepType: "deps", stepLabel: `Remove ${pkg}` });
}

async function cmdPort(port: string | undefined, cwd: string) {
  const isWin = process.platform === "win32";
  const checkPort = async (p: number | string) => {
    const cmd = isWin
      ? `netstat -ano | findstr :${p}`
      : `lsof -i :${p} -t 2>/dev/null`;
    return runCommand(cmd, cwd);
  };

  if (!port) {
    console.log(chalk.blue("Checking common ports..."));
    for (const p of [3000, 5173, 8080, 4200, 8000]) {
      const result = await checkPort(p);
      if (result.stdout.trim()) {
        console.log(chalk.yellow(`  Port ${p}: IN USE (PID: ${result.stdout.trim().split("\n")[0]})`));
      } else {
        console.log(chalk.green(`  Port ${p}: available`));
      }
    }
    return;
  }
  // Reject non-numeric or out-of-range ports up front. Without this an input
  // like "abc" or "99999" was passed straight to lsof/netstat, which matched
  // nothing and was reported as "available" — a misleading false negative (and
  // an unnecessary raw-string interpolation into a shell command).
  const portNumber = Number(port);
  if (!/^\d+$/.test(port.trim()) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    throw createSetuprError({
      code: "INVALID_ARGUMENT",
      command: "port",
      details: [`"${port}" is not a valid port. Ports must be an integer between 1 and 65535.`],
      canContinue: false,
    });
  }
  const result = await checkPort(portNumber);
  if (result.stdout.trim()) {
    const pid = result.stdout.trim().split("\n")[0];
    console.log(chalk.yellow(`Port ${portNumber} in use by PID: ${pid}`));
    console.log(chalk.dim(isWin ? `Kill with: taskkill /PID ${pid} /F` : `Kill with: kill ${pid}`));
  } else {
    console.log(chalk.green(`Port ${portNumber} is available`));
  }
}

interface PackageJsonInfo {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  license?: string | { type?: string };
}

interface LockPackageInfo {
  name: string;
  version?: string;
  license?: string | { type?: string };
  path: string;
  dependencies: string[];
}

interface DependencySnapshot {
  packageJson?: PackageJsonInfo;
  lockfile?: any;
  lockfileError?: string;
  packages: LockPackageInfo[];
}

async function cmdDeps(sub: string | undefined, cwd: string, flags?: Flags) {
  switch (sub) {
    case undefined:
    case "list":
      return cmdDepsList(cwd);
    case "audit":
      return cmdDepsAudit(cwd);
    case "why":
      return cmdDepsWhy(cwd, flags?.args?.[0]);
    case "licenses":
      return cmdDepsLicenses(cwd);
    default:
      printPlainError(createSetuprError({
        code: "UNKNOWN_SUBCOMMAND",
        command: "deps",
        subcommand: sub,
        cwd,
        details: ["Valid: list, audit, why <package>, licenses"],
      }));
  }
}

async function cmdDepsList(cwd: string) {
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  console.log(chalk.blue(`Dependencies (${pm}):`));

  const listCommand = dependencyListCommand(pm);
  if (!listCommand) {
    await printDeclaredDependencies(cwd, scan, `No live dependency tree command is configured for ${pm}.`);
    return;
  }

  const result = await runCommand(listCommand, cwd);
  if (result.exitCode !== 0) {
    const shown = await printDeclaredDependencies(cwd, scan, "Package manager dependency tree is unavailable; showing package.json declarations or ecosystem declarations instead.");
    if (!shown) {
      printPlainError(classifyCommandFailure({ command: listCommand, cwd, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }));
      return;
    }
  } else {
    console.log(result.stdout || result.stderr);
  }
}

function dependencyListCommand(packageManager: string): string | null {
  switch (packageManager) {
    case "npm":
    case "yarn":
    case "pnpm":
    case "bun":
      return `${packageManager} list --depth=0`;
    case "pip":
      return "python3 -m pip list || python -m pip list || pip list";
    case "poetry":
      return "poetry show --no-dev";
    case "pipenv":
      return "pipenv graph";
    case "go":
      return "go list -m all";
    case "cargo":
      return null;
    default:
      return null;
  }
}

async function printDeclaredDependencies(cwd: string, scan: Awaited<ReturnType<typeof scanProject>>, reason: string): Promise<boolean> {
  console.log(chalk.yellow(`  ${reason}`));
  const rows = await declaredDependencyRowsForProject(cwd, scan);
  if (rows.length === 0) return false;
  for (const row of rows) {
    console.log(`  ${row.kind.padEnd(22)} ${row.name}${row.range ? `@${row.range}` : ""}`);
  }
  return true;
}

async function declaredDependencyRowsForProject(
  cwd: string,
  scan: Awaited<ReturnType<typeof scanProject>>
): Promise<Array<{ kind: string; name: string; range: string }>> {
  const snapshot = await loadDependencySnapshot(cwd);
  const nodeRows = declaredDependencyRows(snapshot.packageJson);
  if (nodeRows.length > 0) return nodeRows;

  if (scan.packageManager === "cargo" || scan.language === "Rust") {
    return parseCargoDependencies(await readTextFile(join(cwd, "Cargo.toml")));
  }
  if (scan.packageManager === "go" || scan.language === "Go") {
    return parseGoDependencies(await readTextFile(join(cwd, "go.mod")));
  }
  if (scan.language === "Python") {
    return [
      ...parseRequirementsDependencies(await readTextFile(join(cwd, "requirements.txt"))),
      ...parsePyprojectDependencies(await readTextFile(join(cwd, "pyproject.toml"))),
    ];
  }
  return [];
}

async function readTextFile(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

function parseCargoDependencies(content: string): Array<{ kind: string; name: string; range: string }> {
  const rows: Array<{ kind: string; name: string; range: string }> = [];
  let section = "";
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^\[.+\]$/.test(trimmed)) {
      section = trimmed;
      continue;
    }
    if (section !== "[dependencies]" && section !== "[dev-dependencies]" && section !== "[build-dependencies]") continue;
    const match = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!match) continue;
    rows.push({ kind: section.slice(1, -1), name: match[1], range: match[2].replace(/^"|"$/g, "") });
  }
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function parseGoDependencies(content: string): Array<{ kind: string; name: string; range: string }> {
  const rows: Array<{ kind: string; name: string; range: string }> = [];
  let inRequireBlock = false;
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("require (")) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && trimmed === ")") {
      inRequireBlock = false;
      continue;
    }
    const depLine = inRequireBlock ? trimmed : trimmed.startsWith("require ") ? trimmed.slice("require ".length).trim() : "";
    if (!depLine) continue;
    const [name, range] = depLine.split(/\s+/, 2);
    if (name && range) rows.push({ kind: "require", name, range });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

function parseRequirementsDependencies(content: string): Array<{ kind: string; name: string; range: string }> {
  return content.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("-"))
    .map((line) => {
      const match = line.match(/^([A-Za-z0-9_.-]+)\s*([<>=!~].*)?$/);
      return { kind: "requirements", name: match?.[1] || line, range: match?.[2] || "" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function parsePyprojectDependencies(content: string): Array<{ kind: string; name: string; range: string }> {
  const rows: Array<{ kind: string; name: string; range: string }> = [];
  const dependenciesBlock = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/m)?.[1] || "";
  for (const raw of dependenciesBlock.split(",")) {
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    const match = value.match(/^([A-Za-z0-9_.-]+)\s*(.*)$/);
    rows.push({ kind: "pyproject", name: match?.[1] || value, range: match?.[2] || "" });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

async function cmdDepsAudit(cwd: string): Promise<void> {
  console.log(chalk.blue.bold("\n  Dependency Audit\n"));
  const result = await runCommand("npm audit --json", cwd);
  const audit = parseFirstJson(result.stdout) || parseFirstJson(result.stderr);

  if (!audit) {
    console.log(chalk.yellow("  Audit unavailable."));
    if (!existsSync(join(cwd, "package-lock.json"))) {
      console.log(chalk.dim("  No package-lock.json found; npm audit needs a lockfile."));
    } else {
      console.log(chalk.dim("  npm audit did not return JSON. This can happen offline or during registry errors."));
    }
    return;
  }
  if (audit.error) {
    console.log(chalk.yellow("  Audit unavailable."));
    console.log(chalk.dim(`  npm audit returned ${audit.error.code || "an error"}${audit.error.summary ? `: ${audit.error.summary}` : ""}`));
    if (audit.error.detail) console.log(chalk.dim(`  ${audit.error.detail}`));
    process.exitCode = result.exitCode || 1;
    return;
  }

  const counts = auditCounts(audit);
  const total = counts.total ?? Object.entries(counts)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + Number(value || 0), 0);

  const color = total === 0 ? chalk.green : counts.critical || counts.high ? chalk.red : chalk.yellow;
  console.log(`  Vulnerabilities: ${color(String(total))}`);
  for (const severity of ["critical", "high", "moderate", "low", "info"] as const) {
    console.log(`  ${severity.padEnd(8)} ${counts[severity] || 0}`);
  }

  const vulnerablePackages = auditVulnerablePackages(audit);
  if (vulnerablePackages.length > 0) {
    console.log("");
    console.log(chalk.white("  Packages:"));
    for (const item of vulnerablePackages.slice(0, 10)) {
      console.log(`  - ${item.name} (${item.severity}${item.fixAvailable ? ", fix available" : ""})`);
    }
    if (vulnerablePackages.length > 10) {
      console.log(chalk.dim(`  ...and ${vulnerablePackages.length - 10} more`));
    }
  } else if (total === 0) {
    console.log(chalk.green("\n  No known vulnerabilities reported."));
  }
}

async function cmdDepsWhy(cwd: string, packageName: string | undefined): Promise<void> {
  if (!packageName) {
    printPlainError(createSetuprError({
      code: "MISSING_PACKAGE",
      command: "deps",
      subcommand: "why",
      cwd,
      details: ["Usage: setupr deps why <package>"],
    }));
    return;
  }

  const snapshot = await loadDependencySnapshot(cwd);
  const direct = directDependencyKinds(snapshot.packageJson, packageName);
  const locked = snapshot.packages.filter((pkg) => pkg.name === packageName).sort(compareLockPackages);
  const parents = snapshot.packages
    .filter((pkg) => pkg.dependencies.includes(packageName) && pkg.name !== packageName)
    .map((pkg) => `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}`)
    .sort();

  console.log(chalk.blue.bold(`\n  Why ${packageName}?\n`));

  if (direct.length > 0) {
    console.log(chalk.green("  Direct dependency"));
    for (const item of direct) {
      console.log(`  - ${item.kind}: ${item.range}`);
    }
  } else {
    console.log(chalk.dim("  Not declared directly in package.json."));
  }

  if (locked.length > 0) {
    console.log("");
    console.log(chalk.white("  Lockfile entries:"));
    for (const pkg of locked) {
      console.log(`  - ${pkg.name}${pkg.version ? `@${pkg.version}` : ""} (${pkg.path || "root"})`);
    }
  } else if (snapshot.lockfileError) {
    console.log(chalk.yellow(`\n  package-lock.json could not be parsed; transitive signal is limited. ${snapshot.lockfileError}`));
  } else if (!snapshot.lockfile) {
    console.log(chalk.yellow("\n  No package-lock.json found; transitive signal is limited."));
  } else {
    console.log(chalk.yellow("\n  Not found in package-lock.json."));
  }

  if (parents.length > 0) {
    console.log("");
    console.log(chalk.white("  Required by:"));
    for (const parent of [...new Set(parents)]) {
      console.log(`  - ${parent}`);
    }
  } else if (direct.length === 0 && locked.length > 0) {
    console.log(chalk.dim("\n  No parent edge was recorded in package-lock.json."));
  }
}

async function cmdDepsLicenses(cwd: string): Promise<void> {
  const snapshot = await loadDependencySnapshot(cwd);
  console.log(chalk.blue.bold("\n  Dependency Licenses\n"));

  if (snapshot.lockfileError) {
    console.log(chalk.yellow(`  package-lock.json could not be parsed; license signal is limited. ${snapshot.lockfileError}`));
  } else if (!snapshot.lockfile && snapshot.packages.length === 0) {
    console.log(chalk.yellow("  No package-lock.json found; license signal is limited."));
  }

  const restricted = snapshot.packages
    .map((pkg) => ({ ...pkg, licenseText: licenseToString(pkg.license) }))
    .filter((pkg) => pkg.path !== "" && pkg.licenseText && isRestrictedLicense(pkg.licenseText))
    .sort(compareLockPackages);

  const rootLicense = licenseToString(snapshot.packageJson?.license);
  if (rootLicense) {
    console.log(`  Project license: ${rootLicense}`);
  }

  if (restricted.length === 0) {
    console.log(chalk.green("  No GPL/AGPL/LGPL licenses found in available metadata."));
    return;
  }

  console.log(chalk.yellow(`  Restricted/copyleft licenses: ${restricted.length}`));
  for (const pkg of restricted) {
    console.log(`  - ${pkg.name}${pkg.version ? `@${pkg.version}` : ""}: ${pkg.licenseText}`);
  }
}

async function loadDependencySnapshot(cwd: string): Promise<DependencySnapshot> {
  const packageJson = await readJsonFile<PackageJsonInfo>(join(cwd, "package.json"));
  const lockfileResult = await readJsonFileWithError<any>(join(cwd, "package-lock.json"));
  const lockfile = lockfileResult.value;
  return {
    packageJson,
    lockfile,
    lockfileError: lockfileResult.exists && !lockfileResult.ok ? lockfileResult.error : undefined,
    packages: collectLockPackages(lockfile),
  };
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function readJsonFileWithError<T>(path: string): Promise<{ ok: boolean; exists: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, exists: true, value: JSON.parse(await readFile(path, "utf-8")) as T };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (code === "ENOENT") return { ok: false, exists: false };
    return {
      ok: false,
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function collectLockPackages(lockfile: any): LockPackageInfo[] {
  if (!lockfile) return [];

  if (lockfile.packages && typeof lockfile.packages === "object") {
    return Object.entries(lockfile.packages)
      .map(([path, value]) => lockPackageFromPackagesEntry(path, value))
      .filter((pkg): pkg is LockPackageInfo => Boolean(pkg))
      .sort(compareLockPackages);
  }

  if (lockfile.dependencies && typeof lockfile.dependencies === "object") {
    const packages: LockPackageInfo[] = [];
    collectLegacyLockPackages(lockfile.dependencies, packages);
    return packages.sort(compareLockPackages);
  }

  return [];
}

function lockPackageFromPackagesEntry(path: string, value: unknown): LockPackageInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, any>;
  const name = path === "" ? entry.name : nameFromNodeModulesPath(path);
  if (!name) return undefined;
  const dependencies = entry.dependencies && typeof entry.dependencies === "object" ? Object.keys(entry.dependencies) : [];
  return {
    name,
    version: typeof entry.version === "string" ? entry.version : undefined,
    license: entry.license,
    path,
    dependencies: dependencies.sort(),
  };
}

function collectLegacyLockPackages(entries: Record<string, any>, packages: LockPackageInfo[], parentPath = "node_modules"): void {
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    if (!entry || typeof entry !== "object") continue;
    const dependencies = entry.requires && typeof entry.requires === "object" ? Object.keys(entry.requires).sort() : [];
    packages.push({
      name,
      version: typeof entry.version === "string" ? entry.version : undefined,
      license: entry.license,
      path: `${parentPath}/${name}`,
      dependencies,
    });
    if (entry.dependencies && typeof entry.dependencies === "object") {
      collectLegacyLockPackages(entry.dependencies, packages, `${parentPath}/${name}/node_modules`);
    }
  }
}

function nameFromNodeModulesPath(path: string): string | undefined {
  const marker = "node_modules/";
  const index = path.lastIndexOf(marker);
  if (index === -1) return undefined;
  return path.slice(index + marker.length);
}

function directDependencyKinds(packageJson: PackageJsonInfo | undefined, packageName: string): Array<{ kind: string; range: string }> {
  if (!packageJson) return [];
  const groups: Array<[keyof PackageJsonInfo, string]> = [
    ["dependencies", "dependencies"],
    ["devDependencies", "devDependencies"],
    ["optionalDependencies", "optionalDependencies"],
    ["peerDependencies", "peerDependencies"],
  ];
  return groups.flatMap(([key, label]) => {
    const deps = packageJson[key];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) return [];
    const range = (deps as Record<string, string>)[packageName];
    return range ? [{ kind: label, range }] : [];
  });
}

function declaredDependencyRows(packageJson: PackageJsonInfo | undefined): Array<{ kind: string; name: string; range: string }> {
  if (!packageJson) return [];
  const groups: Array<[keyof PackageJsonInfo, string]> = [
    ["dependencies", "dependencies"],
    ["devDependencies", "devDependencies"],
    ["optionalDependencies", "optionalDependencies"],
    ["peerDependencies", "peerDependencies"],
  ];
  return groups.flatMap(([key, label]) => {
    const deps = packageJson[key];
    if (!deps || typeof deps !== "object" || Array.isArray(deps)) return [];
    return Object.entries(deps as Record<string, string>).map(([name, range]) => ({ kind: label, name, range }));
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function parseFirstJson(text: string): any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function auditCounts(audit: any): Record<"critical" | "high" | "moderate" | "low" | "info" | "total", number> {
  const metadataCounts = audit?.metadata?.vulnerabilities;
  const base = { critical: 0, high: 0, moderate: 0, low: 0, info: 0, total: 0 };
  if (metadataCounts && typeof metadataCounts === "object") {
    const counts = { ...base, ...metadataCounts };
    counts.total = Number(counts.total || counts.critical + counts.high + counts.moderate + counts.low + counts.info);
    return counts;
  }

  const packages = auditVulnerablePackages(audit);
  for (const item of packages) {
    if (item.severity in base) base[item.severity as keyof typeof base]++;
  }
  base.total = packages.length;
  return base;
}

function auditVulnerablePackages(audit: any): Array<{ name: string; severity: string; fixAvailable: boolean }> {
  const vulnerabilities = audit?.vulnerabilities || audit?.advisories || {};
  if (!vulnerabilities || typeof vulnerabilities !== "object") return [];
  return Object.entries(vulnerabilities)
    .map(([name, value]) => {
      const entry = value as Record<string, any>;
      return {
        name,
        severity: String(entry.severity || "unknown"),
        fixAvailable: Boolean(entry.fixAvailable),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function licenseToString(license: unknown): string {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && "type" in license) {
    const type = (license as { type?: unknown }).type;
    return typeof type === "string" ? type : "";
  }
  return "";
}

function isRestrictedLicense(license: string): boolean {
  return /\b(A?GPL|LGPL)(?:[-\s]?|\b)/i.test(license);
}

function compareLockPackages(a: LockPackageInfo, b: LockPackageInfo): number {
  return a.name.localeCompare(b.name) || (a.version || "").localeCompare(b.version || "") || a.path.localeCompare(b.path);
}

async function cmdConfig(sub: string | undefined, cwd: string, flags?: Flags) {
  const { loadConfig, saveConfig } = await import("../../state/config.js");
  const config = await loadConfig();

  if (!sub || sub === "show") {
    console.log(chalk.blue.bold("\n  Setupr Config\n"));
    console.log(`  AI enabled:     ${chalk.white(String(config.ai.enabled))}`);
    console.log(`  AI model:       ${chalk.white(config.ai.model || "auto-detect")}`);
    console.log(`  Theme:          ${chalk.white(config.preferences.theme)}`);
    console.log(`  Confirm install: ${chalk.white(String(config.preferences.confirmBeforeInstall))}`);
    console.log(`  Auto update:    ${chalk.white(String(config.preferences.autoUpdate))}`);
    console.log("");
    console.log(chalk.dim("  Use 'setupr config set <key> <value>' to change"));
    return;
  }

  if (sub === "set") {
    const args: string[] = flags?.args || [];
    const key = args[0];
    const value = args.slice(1).join(" ");

    if (!key || !value) {
      printPlainError(createSetuprError({
        code: "UNKNOWN_SUBCOMMAND",
        command: "config",
        subcommand: "set",
        cwd,
        details: ["Usage: setupr config set <key> <value>", "Keys: model, theme, confirm, autoupdate, ai"],
      }));
      return;
    }

    switch (key) {
      case "model":
        config.ai.model = value;
        break;
      case "theme":
        if (value === "dark" || value === "light") {
          config.preferences.theme = value;
        } else {
          printPlainError(createSetuprError({
            code: "PROJECT_CONFIG_INVALID",
            command: "config",
            subcommand: "set",
            cwd,
            details: [`Theme must be 'dark' or 'light'. Received: ${value}`],
          }));
          return;
        }
        break;
      case "confirm":
        config.preferences.confirmBeforeInstall = value === "true" || value === "1" || value === "yes";
        break;
      case "autoupdate":
        config.preferences.autoUpdate = value === "true" || value === "1" || value === "yes";
        break;
      case "ai":
        config.ai.enabled = value === "true" || value === "1" || value === "yes";
        break;
      default:
        printPlainError(createSetuprError({
          code: "PROJECT_CONFIG_INVALID",
          command: "config",
          subcommand: "set",
          cwd,
          details: [`Unknown key: ${key}`, "Valid keys: model, theme, confirm, autoupdate, ai"],
        }));
        return;
    }

    await saveConfig(config);
    console.log(chalk.green(`✓ Set ${key} = ${value}`));
    return;
  }

  if (sub === "reset") {
    await saveConfig({
      ai: { enabled: true, timeoutMs: 30000, maxRetries: 3, retryDelayMs: 1000, rateLimitPerMinute: 20 },
      preferences: { theme: "dark", confirmBeforeInstall: true, autoUpdate: false, telemetry: false, defaultBranch: "main", commitConvention: "conventional", ciPlatform: "auto" },
      plugins: [],
      remembered: {},
    });
    console.log(chalk.green("✓ Config reset to defaults"));
    return;
  }

  if (sub === "models") {
    const { MODELS, PROVIDERS, formatModelPrice, getAvailableModels, getDefaultModel, getProviderEnvValue } = await import("../../ai/models.js");
    const available = getAvailableModels();
    const active = getDefaultModel();
    console.log(chalk.blue.bold("\n  Available AI Models\n"));

    const providers = [...new Set(MODELS.map((m) => m.provider))];
    for (const provider of providers) {
      const providerConfig = PROVIDERS[provider];
      const hasKey = !!getProviderEnvValue(provider);
      const providerModels = MODELS.filter((m) => m.provider === provider);
      const keys = [providerConfig.envKey, ...(providerConfig.envAliases || [])].join(" or ");
      console.log(`  ${hasKey ? chalk.green("●") : chalk.red("○")} ${chalk.white(provider)} ${chalk.dim(`(${keys})`)}`);
      for (const model of providerModels) {
        const isAvailable = available.includes(model);
        const marker = model.id === active.id ? chalk.yellow("★ ") : "  ";
        console.log(`  ${marker}${isAvailable ? chalk.green(model.id) : chalk.dim(model.id)} — ${model.name} ${chalk.dim(formatModelPrice(model))}`);
      }
    }
    console.log(chalk.dim(`\n  ${available.length} models available (set API keys to unlock more)`));
    return;
  }

  printPlainError(createSetuprError({
    code: "UNKNOWN_SUBCOMMAND",
    command: "config",
    subcommand: sub,
    cwd,
    details: ["Valid subcommands: show, set, reset, models."],
  }));
}

async function cmdLock(cwd: string) {
  const { saveCheckpoint } = await import("../../state/checkpoint.js");
  const scan = await scanProject(cwd);
  await saveCheckpoint(cwd, { cwd, scan, steps: [], currentStepIndex: 0, completedSteps: [] });
  console.log(chalk.green("✓ Environment state locked to .setupr/checkpoint.json"));
}

async function cmdDiff(cwd: string) {
  const { loadCheckpoint } = await import("../../state/checkpoint.js");
  const cp = await loadCheckpoint(cwd);
  if (!cp) {
    printPlainError(createSetuprError({ code: "LOCK_STATE_MISSING", command: "diff", cwd }));
    return;
  }
  const scan = await scanProject(cwd);
  console.log(chalk.blue.bold("\n  Environment Diff\n"));
  console.log(chalk.dim(`  Locked at: ${new Date(cp.timestamp).toLocaleString()}`));
  let changes = 0;
  if (cp.scan.language !== scan.language) { console.log(chalk.yellow(`  Language: ${cp.scan.language} → ${scan.language}`)); changes++; }
  if (cp.scan.dependencies.prod !== scan.dependencies.prod) { console.log(chalk.yellow(`  Prod deps: ${cp.scan.dependencies.prod} → ${scan.dependencies.prod}`)); changes++; }
  if (cp.scan.dependencies.dev !== scan.dependencies.dev) { console.log(chalk.yellow(`  Dev deps: ${cp.scan.dependencies.dev} → ${scan.dependencies.dev}`)); changes++; }
  if (changes === 0) console.log(chalk.green("  No major changes detected"));
  console.log("");
}

async function cmdLogs(cwd: string) {
  const logFiles = ["npm-debug.log", "yarn-error.log", "pnpm-debug.log", ".setupr/logs/latest.log"];
  for (const file of logFiles) {
    try {
      const content = await readFile(join(cwd, file), "utf-8");
      console.log(chalk.blue(`\n--- ${file} ---\n`));
      console.log(content.slice(-2000));
      return;
    } catch {}
  }
  printPlainError(createSetuprError({
    code: "LOG_FILE_MISSING",
    command: "logs",
    cwd,
    details: [`Checked: ${logFiles.join(", ")}`],
  }));
}

async function cmdProcessLogs(cwd: string, target?: string) {
  const { readProcessLog } = await import("../../processes/manager.js");
  const result = await readProcessLog(cwd, target, 120);
  if (result.process && result.content.trim()) {
    console.log(chalk.blue.bold(`\n  Logs: ${result.process.name}\n`));
    console.log(result.content);
    return;
  }
  if (target) {
    printPlainError(createSetuprError({
      code: "LOG_FILE_MISSING",
      command: "logs",
      subcommand: target,
      cwd,
      details: [`No managed process log found for ${target}.`],
    }));
    return;
  }
  await cmdLogs(cwd);
}

async function cmdPs(cwd: string, flags: Flags) {
  const { listManagedProcesses } = await import("../../processes/manager.js");
  const processes = await listManagedProcesses(cwd);
  if (flags.json) {
    console.log(JSON.stringify(processes, null, 2));
    return;
  }
  console.log(chalk.blue.bold("\n  Setupr Processes\n"));
  if (processes.length === 0) {
    console.log(chalk.dim("  No Setupr-managed processes."));
    console.log(chalk.dim("  Start one with: setupr start --plain"));
    console.log("");
    return;
  }
  for (const proc of processes) {
    const color = proc.status === "running" ? chalk.green : proc.status === "crashed" ? chalk.red : chalk.dim;
    console.log(`  ${color(proc.status.padEnd(8))} ${chalk.white(proc.id.padEnd(14))} ${proc.pid ? chalk.dim(`pid ${proc.pid}`) : chalk.dim("no pid")}  ${chalk.dim(proc.command)}`);
  }
  console.log("");
}

async function cmdStop(cwd: string, target: string | undefined, flags: Flags) {
  const { stopManagedProcess } = await import("../../processes/manager.js");
  const stopped = await stopManagedProcess(cwd, target, { force: flags.force });
  if (stopped.length === 0) {
    console.log(chalk.dim(target ? `No managed process found for ${target}.` : "No running managed processes."));
    return;
  }
  for (const proc of stopped) {
    console.log(chalk.green(`✓ Stopped ${proc.id}${proc.pid ? ` (pid ${proc.pid})` : ""}`));
  }
}

async function cmdRestart(cwd: string, target: string | undefined, flags: Flags) {
  const { restartManagedProcess } = await import("../../processes/manager.js");
  const proc = await restartManagedProcess(cwd, target, { force: flags.force, autoRestart: Boolean(flags.watch) });
  console.log(chalk.green(`✓ Restarted ${proc.id}`));
  console.log(chalk.dim(`  PID: ${proc.pid || "unknown"}`));
  console.log(chalk.dim(`  Logs: ${proc.logFile}`));
}

async function cmdBuild(cwd: string) {
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  if (scan.scripts.build) {
    await runPlainCommand(`${pm} run build`, cwd, { stepType: "script", stepLabel: "build" });
  } else {
    printPlainError(createSetuprError({
      code: "MISSING_SCRIPT",
      command: "build",
      cwd,
      details: ["No build script found in package.json."],
    }));
  }
}

async function cmdDeploy(cwd: string) {
  const scan = await scanProject(cwd);
  const pm = scan.packageManager || "npm";
  if (scan.scripts.deploy) {
    await runPlainCommand(`${pm} run deploy`, cwd, { stepType: "script", stepLabel: "deploy" });
  } else {
    printPlainError(createSetuprError({
      code: "MISSING_SCRIPT",
      command: "deploy",
      cwd,
      details: ["No deploy script found. Add a 'deploy' script to package.json."],
    }));
  }
}

async function cmdOpen(target: string | undefined, cwd: string, flags: Flags) {
  const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
  switch (target) {
    case "repo": {
      const remote = selectGitRemote(await readGitRemotes(cwd), typeof flags.remote === "string" ? flags.remote : undefined);
      let url = remote?.githubRepo ? `https://github.com/${remote.githubRepo}` : remote?.url;
      if (url && !url.includes("://")) url = url.replace(/^([^/:]+):(.+)$/, "https://$1/$2");
      if (url?.startsWith("ssh://")) url = url.replace(/^ssh:\/\//, "https://");
      if (url && /^https?:\/\//.test(url)) {
        url = url.replace(/\.git\/?$/, "");
        const result = await runCommandArgs(openCmd, [url], cwd);
        if (result.exitCode !== 0) {
          printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "open", subcommand: "repo", cwd, details: ["The browser opener failed."] }));
          return;
        }
        console.log(chalk.green(`Opened: ${url}`));
      } else {
        printPlainError(createSetuprError({
          code: "OPEN_TARGET_MISSING",
          command: "open",
          subcommand: "repo",
          cwd,
          details: ["No web repository URL was found for the selected remote."],
        }));
      }
      break;
    }
    case "ide":
      await runCommand("code .", cwd);
      console.log(chalk.green("Opened in VS Code"));
      break;
    default:
      await runCommand(`${openCmd} http://localhost:3000`, cwd);
      console.log(chalk.green("Opened http://localhost:3000"));
  }
}

async function runPlainCommand(command: string, cwd: string, context: { stepType?: string; stepLabel?: string; ownerCommand?: string; ownerSubcommand?: string; force?: boolean; dryRun?: boolean } = {}) {
  await runProjectCommandOperation({
    cwd,
    ownerCommand: context.ownerCommand || context.stepLabel || "run",
    ownerSubcommand: context.ownerSubcommand,
    shellCommand: command,
    stepType: context.stepType,
    stepLabel: context.stepLabel,
    force: context.force,
    dryRun: context.dryRun,
  });
}

function envReadErrorCode(error: unknown): "ENV_TEMPLATE_MISSING" | "ENV_CHECK_FAILED" {
  const code = (error as { code?: string } | undefined)?.code;
  return code === "ENOENT" ? "ENV_TEMPLATE_MISSING" : "ENV_CHECK_FAILED";
}

function isLikelyInvalid(key: string, value: string): boolean {
  const k = key.toUpperCase();
  const v = value.trim();

  if (v === "your_key_here" || v === "changeme" || v === "TODO" || v === "xxx" || v === "REPLACE_ME") return true;

  if ((k.includes("URL") || k.includes("ENDPOINT") || k.includes("HOST")) && !v.startsWith("http") && !v.startsWith("localhost") && !v.includes(":")) return true;
  if ((k.includes("PORT")) && (isNaN(Number(v)) || Number(v) < 1 || Number(v) > 65535)) return true;
  if ((k.includes("KEY") || k.includes("SECRET") || k.includes("TOKEN")) && v.length < 8) return true;
  if ((k.includes("EMAIL")) && !v.includes("@")) return true;

  return false;
}

function getInvalidReason(key: string, value: string): string {
  const k = key.toUpperCase();
  const v = value.trim();

  if (v === "your_key_here" || v === "changeme" || v === "TODO" || v === "xxx" || v === "REPLACE_ME") return "placeholder value";
  if ((k.includes("URL") || k.includes("ENDPOINT") || k.includes("HOST")) && !v.startsWith("http") && !v.startsWith("localhost") && !v.includes(":")) return "doesn't look like a URL";
  if ((k.includes("PORT")) && (isNaN(Number(v)) || Number(v) < 1 || Number(v) > 65535)) return "invalid port number";
  if ((k.includes("KEY") || k.includes("SECRET") || k.includes("TOKEN")) && v.length < 8) return "too short for a key/secret";
  if ((k.includes("EMAIL")) && !v.includes("@")) return "missing @ symbol";

  return "may be invalid";
}
