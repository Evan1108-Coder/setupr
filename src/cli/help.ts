import chalk from "chalk";
import { createSetuprError, printPlainError } from "../errors/index.js";
import { GLOBAL_OPTIONS, getCommand, publicCommands, type CommandEntry } from "./commandRegistry.js";

interface HelpNode {
  name: string;
  summary: string;
  usage: string;
  commands?: Array<{ name: string; summary: string; usage?: string }>;
  options?: Array<{ name: string; summary: string }>;
  examples?: string[];
}

const GLOBAL_HELP: HelpNode = {
  name: "setupr",
  summary: "Project control center for setup, operations, diagnostics, and AI-assisted workflows.",
  usage: "setupr [command] [options]",
  commands: publicCommands().map((command) => ({ name: command.name, summary: command.summary, usage: command.usage })),
  options: GLOBAL_OPTIONS,
  examples: ["setupr", "setupr setup", "setupr help auth", "setupr auth login", "setupr env init --force"],
};

const HELP_NODES: Record<string, HelpNode> = {
  setup: {
    name: "setup",
    summary: "Scan, plan, install/configure, verify, and explain a project setup.",
    usage: "setupr setup [--force] [--plain|--no-tui]",
    options: [
      { name: "--force", summary: "Use safe defaults and ask only for blockers." },
      { name: "--plain, --no-tui", summary: "Run without the TUI." },
    ],
    examples: ["setupr", "setupr setup --force", "setupr setup --plain --force"],
  },
  chat: {
    name: "chat",
    summary: "Open the project AI director chat TUI, or ask one question in plain mode.",
    usage: "setupr chat [message|start|resume] [--new|--resume|--plain|--json|--model <id>]",
    options: [
      { name: "--new", summary: "Start a fresh chat session and ignore saved chat history." },
      { name: "--resume", summary: "Resume the latest saved project chat session." },
      { name: "--plain, --no-tui", summary: "Run one-shot plain chat output instead of the TUI." },
      { name: "--json", summary: "Emit one-shot plain chat output as JSON." },
      { name: "--model <id>", summary: "Use a specific AI model for this chat request/session." },
    ],
    examples: [
      "setupr chat",
      "setupr chat how do I start this app?",
      "setupr chat --new",
      "setupr chat resume",
      "setupr chat --plain what failed last time?",
    ],
  },
  auth: {
    name: "auth",
    summary: "Manage global Setupr AI provider API keys and active model.",
    usage: "setupr auth <command> [options]",
    commands: [
      { name: "login", summary: "Guided provider API key setup." },
      { name: "list", summary: "List providers and masked API key status." },
      { name: "status", summary: "Show active model, selected provider, and key source." },
      { name: "set-key", summary: "Save a provider API key globally." },
      { name: "remove", summary: "Remove one saved provider API key." },
      { name: "logout", summary: "Alias for remove." },
      { name: "test", summary: "Send tiny connectivity checks to configured providers." },
      { name: "models", summary: "Show supported models and availability." },
      { name: "use", summary: "Set the active model globally." },
      { name: "doctor", summary: "Run deeper auth diagnostics." },
      { name: "migrate", summary: "Move Setupr provider keys from project .env into global auth." },
      { name: "reset", summary: "Remove all saved provider API keys after confirmation." },
    ],
    options: [
      { name: "--key <value>", summary: "Provide API key inline; safer to omit and use hidden prompt." },
      { name: "--force", summary: "Skip confirmations for replace/remove/reset and allow empty env creation where supported." },
      { name: "--plain", summary: "Use plain output." },
    ],
    examples: [
      "setupr auth login",
      "setupr auth set-key github",
      "setupr auth test github",
      "setupr auth use openai/gpt-4.1-mini",
      "setupr auth migrate --force",
    ],
  },
  "auth set-key": {
    name: "auth set-key",
    summary: "Save one provider API key in global Setupr auth storage.",
    usage: "setupr auth set-key <provider> [--key <api-key>] [--force]",
    options: [
      { name: "--key <api-key>", summary: "Use inline value; may be visible in shell history." },
      { name: "--force", summary: "Replace an existing saved key without confirmation." },
    ],
    examples: ["setupr auth set-key github", "setupr auth set-key minimax --force"],
  },
  "auth test": {
    name: "auth test",
    summary: "Test one or all configured AI providers with tiny requests.",
    usage: "setupr auth test [provider]",
    examples: ["setupr auth test", "setupr auth test github"],
  },
  env: {
    name: "env",
    summary: "Open the .env editor TUI or manage the project .env file from .env.example.",
    usage: "setupr env [init|check|sync|smart] [--force|--plain]",
    commands: [
      { name: "(no subcommand)", summary: "Open the interactive .env editor TUI. Creates .env from .env.example after confirmation when needed." },
      { name: "init", summary: "Create .env from .env.example. Without .env.example, requires --force to create empty .env." },
      { name: "check", summary: "Report missing values required by .env.example." },
      { name: "sync", summary: "Add missing template keys while preserving existing values, comments, and extra keys." },
      { name: "smart", summary: "Analyze missing, empty, invalid, extra, and changed env values." },
    ],
    options: [
      { name: "--plain, --no-tui", summary: "Show a non-interactive env summary/error instead of the editor." },
      { name: "--force", summary: "With init, overwrite existing .env or create empty .env when no .env.example exists." },
    ],
    examples: ["setupr env", "setupr env --force", "setupr env init", "setupr env init --force", "setupr env check", "setupr env smart"],
  },
  clean: {
    name: "clean",
    summary: "Remove generated or local-only artifacts.",
    usage: "setupr clean [deps|share|all] [--force] [--plain]",
    options: [
      { name: "--deps", summary: "Remove dependency/install artifacts." },
      { name: "--share", summary: "Remove local sensitive/share-sensitive files." },
      { name: "--all", summary: "Remove dependencies, build outputs, caches, and local env files." },
      { name: "--force", summary: "Skip confirmation." },
    ],
    examples: ["setupr clean deps", "setupr clean --share --force", "setupr clean all --plain --force"],
  },
  config: {
    name: "config",
    summary: "Manage global Setupr preferences.",
    usage: "setupr config <show|set|reset|models>",
    commands: [
      { name: "show", summary: "Show current config." },
      { name: "set", summary: "Set model, theme, confirm, autoupdate, or ai." },
      { name: "reset", summary: "Restore defaults." },
      { name: "models", summary: "Show model catalog. Auth commands are preferred for model/auth work." },
    ],
    examples: ["setupr config show", "setupr config set theme light", "setupr auth models"],
  },
  git: {
    name: "git",
    summary: "Git workflows and repository helpers.",
    usage: "setupr git <command> [options]",
    commands: [
      { name: "init", summary: "Initialize git and generate a stack-aware .gitignore." },
      { name: "hooks", summary: "Install or remove useful git hooks." },
      { name: "flow", summary: "Create and finish feature, hotfix, and release branches." },
      { name: "commit-message", summary: "Suggest a deterministic commit message from changed files." },
      { name: "commit", summary: "Stage and commit changes with optional conventional messages." },
      { name: "pr-description", summary: "Draft a PR body from branch diff signals." },
      { name: "branch-check", summary: "Warn about main-branch work and branch state." },
      { name: "conflicts", summary: "List unmerged files and conflict markers." },
      { name: "branch", summary: "Create, list, delete, or clean branches." },
      { name: "pr", summary: "Open or prepare pull request flows." },
      { name: "stash", summary: "Save, list, pop, or drop stashes." },
      { name: "rebase", summary: "Run guided rebase workflows." },
      { name: "tag", summary: "Create and list tags." },
      { name: "release", summary: "Prepare a release commit/tag flow." },
      { name: "status", summary: "Show concise repository status." },
      { name: "log", summary: "Show recent history." },
      { name: "sync", summary: "Pull and push the current branch." },
      { name: "clean", summary: "Clean git-ignored files after confirmation." },
      { name: "ignore", summary: "Generate or update .gitignore." },
      { name: "changelog", summary: "Generate changelog content from commits." },
      { name: "blame", summary: "Show blame for a file." },
      { name: "cherry-pick", summary: "Cherry-pick a commit." },
      { name: "worktree", summary: "Manage git worktrees." },
      { name: "bisect", summary: "Start or continue bisect workflows." },
      { name: "contributors", summary: "Show repository contributors." },
      { name: "undo", summary: "Undo commit, stage, or local changes with safeguards." },
    ],
    options: [
      { name: "--force", summary: "Skip ordinary confirmations where the git command supports it." },
      { name: "--remote <name>", summary: "Choose a remote for git pr or git sync; unknown names fail without fallback." },
    ],
    examples: ["setupr git status", "setupr git commit-message", "setupr git pr-description", "setupr git conflicts"],
  },
  init: {
    name: "init",
    summary: "Scaffold a new project.",
    usage: "setupr init [stack|name] [options]",
    options: [
      { name: "--template <name>", summary: "Use a named template when supported." },
      { name: "--force", summary: "Overwrite generated files where supported." },
    ],
    examples: ["setupr init node", "setupr init python", "setupr init --template react-app"],
  },
  migrate: {
    name: "migrate",
    summary: "Migrate package manager metadata and lockfiles.",
    usage: "setupr migrate <npm|yarn|pnpm|bun> [--force]",
    options: [
      { name: "--force", summary: "Proceed through supported destructive replacement steps." },
    ],
    examples: ["setupr migrate pnpm", "setupr migrate npm --force"],
  },
  ci: {
    name: "ci",
    summary: "Generate CI/CD configuration for the current project.",
    usage: "setupr ci <github|gitlab|bitbucket|circleci>",
    examples: ["setupr ci github", "setupr ci gitlab"],
  },
  docker: {
    name: "docker",
    summary: "Generate Docker assets and check Docker readiness.",
    usage: "setupr docker <generate|compose|check> [options]",
    commands: [
      { name: "generate", summary: "Generate a Dockerfile for the detected stack." },
      { name: "compose", summary: "Generate docker-compose.yml for app services." },
      { name: "check", summary: "Check Docker availability and project Docker files." },
    ],
    options: [
      { name: "--force", summary: "Overwrite existing generated Docker files." },
    ],
    examples: ["setupr docker generate", "setupr docker compose --force", "setupr docker check"],
  },
  secrets: {
    name: "secrets",
    summary: "Encrypted project-local secrets management.",
    usage: "setupr secrets <init|set|get|list|remove|export|import|rotate> [name] [value]",
    commands: [
      { name: "init", summary: "Initialize encrypted secret storage." },
      { name: "set", summary: "Store a secret value." },
      { name: "get", summary: "Read a secret value." },
      { name: "list", summary: "List stored secret names without values." },
      { name: "remove", summary: "Remove a secret." },
      { name: "export", summary: "Export secrets for migration." },
      { name: "import", summary: "Import exported secrets." },
      { name: "rotate", summary: "Rotate the local encryption key." },
    ],
    examples: ["setupr secrets init", "setupr secrets set API_KEY", "setupr secrets list"],
  },
  templates: {
    name: "templates",
    summary: "Project template management.",
    usage: "setupr templates <new|list|save|remove> [name-or-url]",
    commands: [
      { name: "new", summary: "Create a project from a GitHub repo or saved template." },
      { name: "list", summary: "List saved templates." },
      { name: "save", summary: "Save the current project as a reusable template." },
      { name: "remove", summary: "Remove a saved template." },
    ],
    examples: ["setupr templates list", "setupr templates new user/repo", "setupr templates save api-starter"],
  },
  workspace: {
    name: "workspace",
    summary: "Monorepo workspace commands.",
    usage: "setupr workspace <list|run|exec|add|info|check> [args]",
    commands: [
      { name: "list", summary: "List workspace packages." },
      { name: "run", summary: "Run a script across workspaces." },
      { name: "exec", summary: "Execute a command across workspaces." },
      { name: "add", summary: "Create a new package directory within the workspace; existing directories are never overwritten." },
      { name: "info", summary: "Show workspace metadata." },
      { name: "check", summary: "Check workspace consistency." },
    ],
    options: [{ name: "--filter <package>", summary: "Run/exec only packages whose name or relative path matches this text." }],
    examples: ["setupr workspace list", "setupr workspace run test --filter @app/api", "setupr workspace check"],
  },
	  health: {
	    name: "health",
	    summary: "Project health checks.",
    usage: "setupr health [full|deps|security|outdated|size]",
    commands: [
      { name: "full", summary: "Run all health checks." },
      { name: "deps", summary: "Check dependency health." },
      { name: "security", summary: "Run security-oriented checks." },
      { name: "outdated", summary: "Check outdated dependencies." },
      { name: "size", summary: "Report project size signals." },
    ],
	    examples: ["setupr health", "setupr health security", "setupr health size"],
	  },
	  test: {
	    name: "test",
	    summary: "Verification command group for project tests, smoke checks, and reports.",
	    usage: "setupr test [run|quick|full|ci|smoke|unit|integration|e2e|watch|coverage|changed|file|failed|doctor|list|report|clean|fix|security] [options]",
	    commands: [
	      { name: "run", summary: "Run the best detected default verification command." },
	      { name: "quick", summary: "Run the fastest safe checks for the current project." },
	      { name: "full", summary: "Run tests, build, typecheck, lint, and security where detected." },
	      { name: "ci", summary: "Run CI-like checks locally." },
	      { name: "smoke", summary: "Run build/start smoke-oriented checks." },
	      { name: "unit", summary: "Run unit test scripts or default tests." },
	      { name: "integration", summary: "Run integration test scripts when present." },
	      { name: "e2e", summary: "Run e2e test scripts when present." },
	      { name: "watch", summary: "Run the watch-mode test script when present." },
	      { name: "coverage", summary: "Run coverage scripts when present." },
	      { name: "changed", summary: "Run targeted checks for changed files where supported." },
	      { name: "file", summary: "Run or explain a single-file test target.", usage: "setupr test file <path>" },
	      { name: "failed", summary: "Retry failed tests where the project supports it." },
	      { name: "doctor", summary: "Explain the project verification setup and missing pieces." },
	      { name: "list", summary: "List detected test files." },
	      { name: "report", summary: "Show the latest Setupr test report." },
	      { name: "clean", summary: "Clean test caches; requires --yes or --force." },
	      { name: "fix", summary: "Run the safest available test/lint fix path." },
	      { name: "security", summary: "Run the Setupr security scan from the test group." },
	    ],
	    options: [
	      { name: "--json", summary: "Print machine-readable results." },
	      { name: "--report <file>", summary: "Write a Markdown or JSON report." },
	      { name: "--yes, --force", summary: "Allow safe writes for clean/create." },
	      { name: "--watch", summary: "Prefer watch scripts where available." },
	    ],
	    examples: ["setupr test quick", "setupr test full --report .setupr/test.md", "setupr test security"],
	  },
	  security: {
	    name: "security",
	    summary: "Defensive security command group for secrets, dependencies, env, Docker, CI, code, routes, auth, and headers.",
	    usage: "setupr security [scan|quick|deep|deps|secrets|env|docker|ci|code|routes|auth|headers|doctor|report|baseline|ignore|fix|watch|test] [options]",
	    commands: [
	      { name: "scan", summary: "Run the standard local security scan." },
	      { name: "quick", summary: "Run fast secret, env, dependency, and Docker checks." },
	      { name: "deep", summary: "Run all local defensive checks." },
	      { name: "deps", summary: "Check dependency and lockfile risk signals." },
	      { name: "secrets", summary: "Scan source files for likely committed secrets." },
	      { name: "env", summary: "Check env templates and public/default env files." },
	      { name: "docker", summary: "Check Dockerfile and compose safety signals." },
	      { name: "ci", summary: "Check CI config risk signals." },
	      { name: "code", summary: "Scan code for dangerous primitives." },
	      { name: "routes", summary: "Check route files for admin/debug paths without auth signals." },
	      { name: "auth", summary: "Check auth implementation risk signals." },
	      { name: "headers", summary: "Inspect HTTP security headers for a target URL.", usage: "setupr security headers --url http://localhost:3000" },
	      { name: "doctor", summary: "Explain security posture and next actions." },
	      { name: "report", summary: "Show the latest Setupr security report." },
	      { name: "baseline", summary: "Save current findings as the accepted baseline." },
	      { name: "ignore", summary: "Ignore one finding id from future reports.", usage: "setupr security ignore <finding-id>" },
	      { name: "fix", summary: "Apply safe metadata fixes with --yes or --force." },
	      { name: "watch", summary: "Run a one-shot scan shaped for watch workflows." },
	      { name: "test", summary: "Run a security scan shaped for test pipelines." },
	    ],
	    options: [
	      { name: "--json", summary: "Print machine-readable results." },
	      { name: "--report <file>", summary: "Write a Markdown or JSON report." },
	      { name: "--url <url>", summary: "Target URL for header checks." },
	      { name: "--force", summary: "Allow external URL header checks and ordinary confirmations." },
	      { name: "--yes", summary: "Allow safe metadata writes such as fix." },
	    ],
	    examples: ["setupr security scan", "setupr security deep --report .setupr/security.md", "setupr security headers --url http://localhost:3000", "setupr security ignore secret:src/app.ts:12"],
	  },
	  share: {
    name: "share",
    summary: "Export and import shareable setup bundles.",
    usage: "setupr share <export|import|inspect> [file]",
    commands: [
      { name: "export", summary: "Create a shareable project setup bundle." },
      { name: "import", summary: "Apply a setup bundle." },
      { name: "inspect", summary: "Inspect a setup bundle before applying it." },
    ],
    examples: ["setupr share export", "setupr share inspect setupr-share.json", "setupr share import setupr-share.json"],
  },
  plugin: {
    name: "plugin",
    summary: "Setupr plugin management and plugin developer tooling.",
    usage: "setupr plugin <create|validate|doctor|install|remove|list|info|enable|disable> [name-or-url]",
    commands: [
      { name: "create", summary: "Scaffold a local Setupr plugin project." },
      { name: "validate", summary: "Validate a plugin manifest and entrypoint." },
      { name: "doctor", summary: "Show plugin developer environment details." },
      { name: "install", summary: "Install a plugin from npm or git." },
      { name: "remove", summary: "Remove an installed plugin." },
      { name: "list", summary: "List installed plugins." },
      { name: "info", summary: "Show plugin metadata." },
      { name: "enable", summary: "Enable a plugin." },
      { name: "disable", summary: "Disable a plugin." },
    ],
    examples: ["setupr plugin create team-tools", "setupr plugin validate ./setupr-plugin-team-tools", "setupr plugin install setupr-plugin-example"],
  },
  lint: {
    name: "lint",
    summary: "Run or configure linting.",
    usage: "setupr lint <run|setup|fix> [--force]",
    commands: [
      { name: "run", summary: "Run the detected lint command." },
      { name: "setup", summary: "Set up linting for the detected stack." },
      { name: "fix", summary: "Run lint fixes where supported." },
    ],
    examples: ["setupr lint run", "setupr lint fix", "setupr lint setup --force"],
  },
  format: {
    name: "format",
    summary: "Run or configure formatting.",
    usage: "setupr format <run|check|setup> [--force]",
    commands: [
      { name: "run", summary: "Format files with the detected formatter." },
      { name: "check", summary: "Check formatting without writing changes." },
      { name: "setup", summary: "Set up formatting for the detected stack." },
    ],
    examples: ["setupr format run", "setupr format check", "setupr format setup"],
  },
  scaffold: {
    name: "scaffold",
    summary: "Advanced compatibility command for local project-file generation.",
    usage: "setupr scaffold <component|page|api|hook|model|test|service|middleware> <name>",
    commands: [
      { name: "component", summary: "Generate a UI component." },
      { name: "page", summary: "Generate a page/route file." },
      { name: "api", summary: "Generate an API route/handler." },
      { name: "hook", summary: "Generate a hook." },
      { name: "model", summary: "Generate a model." },
      { name: "test", summary: "Generate a test file." },
      { name: "service", summary: "Generate a service module." },
      { name: "middleware", summary: "Generate middleware." },
    ],
    examples: ["setupr scaffold component Button", "setupr scaffold api users", "setupr scaffold test src/lib/math.ts"],
  },
};

export function showHelp(path: string[] = []): boolean {
  const normalized = normalizePath(path);
  const key = normalized.join(" ");
  const node = key ? HELP_NODES[key] || registryHelpNode(normalized) : GLOBAL_HELP;
  if (!node) {
    printPlainError(createSetuprError({
      code: "UNKNOWN_SUBCOMMAND",
      command: "help",
      subcommand: path.join(" "),
      details: ["Run setupr help to list all commands."],
    }));
    return false;
  }
  renderHelp(node);
  return true;
}

export function isHelpRequest(command: string, input: string[], helpFlag: boolean): boolean {
  return command === "help" || helpFlag || input.includes("help");
}

export function helpPathFromInput(command: string, input: string[], helpFlag: boolean): string[] {
  if (command === "help") return input.slice(1);
  if (helpFlag) return input.slice(0, 2).filter((item) => item !== "--help");
  const helpIndex = input.indexOf("help");
  return [...input.slice(0, helpIndex), ...input.slice(helpIndex + 1)].slice(0, 2);
}

function renderHelp(node: HelpNode): void {
  console.log(chalk.blue.bold(`\n  ${node.name}`));
  console.log(chalk.white(`  ${node.summary}\n`));
  console.log(chalk.yellow("  Usage"));
  console.log(chalk.dim(`    ${node.usage}\n`));

  if (node.commands?.length) {
    console.log(chalk.yellow("  Commands"));
    for (const command of node.commands) {
      console.log(`    ${chalk.green(command.name.padEnd(12))} ${command.summary}`);
    }
    console.log("");
  }

  if (node.options?.length) {
    console.log(chalk.yellow("  Options"));
    for (const option of node.options) {
      console.log(`    ${chalk.cyan(option.name.padEnd(20))} ${option.summary}`);
    }
    console.log("");
  }

  if (node.examples?.length) {
    console.log(chalk.yellow("  Examples"));
    for (const example of node.examples) {
      console.log(chalk.dim(`    $ ${example}`));
    }
    console.log("");
  }
}

function normalizePath(path: string[]): string[] {
  return path
    .filter(Boolean)
    .filter((item) => item !== "--help" && item !== "-h")
    .slice(0, 2);
}

function registryHelpNode(path: string[]): HelpNode | undefined {
  const command = getCommand(path[0]);
  if (!command) return undefined;
  if (path[1] && command.subcommands && !command.subcommands.some((sub) => sub.name === path[1])) {
    return undefined;
  }
  if (path[1]) {
    const sub = command.subcommands?.find((candidate) => candidate.name === path[1]);
    return {
      name: `${command.name} ${path[1]}`,
      summary: sub?.summary || command.summary,
      usage: sub?.usage || `${command.usage}`,
      options: command.options,
      examples: command.examples,
    };
  }
  return commandToHelpNode(command);
}

function commandToHelpNode(command: CommandEntry): HelpNode {
  return {
    name: command.name,
    summary: command.summary,
    usage: command.usage,
    commands: command.subcommands,
    options: command.options,
    examples: command.examples,
  };
}
