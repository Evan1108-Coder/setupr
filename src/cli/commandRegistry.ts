export type CommandMode = "plain" | "tui" | "both";
export type CommandRisk = "none" | "low" | "medium" | "high";

export interface CommandOption {
  name: string;
  summary: string;
}

export interface CommandEntry {
  id: string;
  name: string;
  summary: string;
  usage: string;
  mode: CommandMode;
  subcommands?: Array<{ name: string; summary: string; usage?: string }>;
  options?: CommandOption[];
  examples?: string[];
  allowsSubcommand?: boolean;
  risk?: CommandRisk;
  writes?: boolean;
  aiCapable?: boolean;
  hidden?: boolean;
  showInGlobalHelp?: boolean;
}

export const GLOBAL_OPTIONS: CommandOption[] = [
  { name: "--explain", summary: "Run in plain mode, then explain the result with AI on stderr (no automatic fixes)." },
  { name: "--plain, --no-tui", summary: "Use non-interactive plain terminal output." },
  { name: "--json", summary: "Emit machine-readable JSON where supported." },
  { name: "--tui", summary: "Prefer a rich TUI when the command has one." },
  { name: "--smart", summary: "Use AI assistance where the command supports it." },
  { name: "--force", summary: "Skip ordinary prompts; never bypass critical blockers." },
  { name: "--yes", summary: "Accept ordinary confirmations where supported." },
  { name: "--fix", summary: "Apply safe fixes where supported." },
  { name: "--verbose", summary: "Show more details." },
  { name: "--quiet", summary: "Show less output where supported." },
  { name: "--watch", summary: "Keep watching and updating where supported." },
  { name: "--new", summary: "Start a fresh session where supported." },
  { name: "--resume", summary: "Resume the latest saved workflow/session where supported." },
  { name: "--scope <name>", summary: "Limit a command to a workspace/package scope." },
  { name: "--filter <package>", summary: "Filter workspace run/exec by package name or path." },
  { name: "--remote <name>", summary: "Select a Git remote for github, git pr/sync, or open repo." },
  { name: "--provider <name>", summary: "Override AI provider where supported." },
  { name: "--model <id>", summary: "Override AI model where supported." },
  { name: "--timeout <seconds>", summary: "Set a command/process timeout where supported." },
  { name: "--report <file>", summary: "Write a JSON or Markdown report where supported." },
  { name: "--url <url>", summary: "Target a URL where supported." },
  { name: "--cwd <path>", summary: "Run against another project directory where supported." },
  { name: "--help", summary: "Show help." },
  { name: "--version", summary: "Show version." },
];

const setupOptions: CommandOption[] = [
  { name: "--force", summary: "Start fresh, use safe defaults, and ask only for blockers." },
  { name: "--plain, --no-tui", summary: "Run setup without the TUI." },
];

export const COMMAND_REGISTRY: CommandEntry[] = [
  {
    id: "dashboard",
    name: "dashboard",
    summary: "Open the project dashboard TUI.",
    usage: "setupr",
    mode: "tui",
    allowsSubcommand: false,
    risk: "none",
    examples: ["setupr", "setupr dashboard"],
  },
  {
    id: "setup",
    name: "setup",
    summary: "Scan, plan, install/configure, verify, and explain project setup.",
    usage: "setupr setup [--force] [--plain|--no-tui]",
    mode: "both",
    allowsSubcommand: false,
    options: setupOptions,
    risk: "medium",
    writes: true,
    aiCapable: true,
    examples: ["setupr setup", "setupr setup --force", "setupr setup --plain --force"],
  },
  { id: "chat", name: "chat", summary: "Open the AI director chat TUI for this project, optionally auto-sending a first message.", usage: "setupr chat [message|start|resume] [--new|--resume|--plain|--json|--model <id>]", mode: "both", options: flagOptions("--model <id>", "--provider <name>", "--json", "--smart", "--plain, --no-tui", "--tui", "--new", "--resume"), aiCapable: true, examples: ["setupr chat", "setupr chat how do I start this app?", "setupr chat --new", "setupr chat resume", "setupr chat --plain what failed last time?"] },
  { id: "status", name: "status", summary: "Show project health, git, env, process, and history status.", usage: "setupr status [--plain|--json|--tui|--watch]", mode: "both", allowsSubcommand: false, options: flagOptions("--plain, --no-tui", "--json", "--tui", "--watch", "--smart"), aiCapable: true, examples: ["setupr status", "setupr status --json"] },
  { id: "start", name: "start", summary: "Start and track a managed project process.", usage: "setupr start [target] [--plain|--tui|--watch|--force]", mode: "both", options: flagOptions("--plain, --no-tui", "--tui", "--smart", "--watch", "--force"), risk: "low", aiCapable: true, writes: true },
  { id: "ps", name: "ps", summary: "List Setupr-managed project processes.", usage: "setupr ps [--plain|--json]", mode: "plain", allowsSubcommand: false, options: flagOptions("--plain, --no-tui", "--json") },
  { id: "stop", name: "stop", summary: "Stop one or all Setupr-managed project processes.", usage: "setupr stop [target] [--force]", mode: "plain", options: flagOptions("--force"), writes: true },
  { id: "restart", name: "restart", summary: "Restart a Setupr-managed project process.", usage: "setupr restart [target] [--force|--watch]", mode: "plain", options: flagOptions("--force", "--watch"), writes: true },
  { id: "doctor", name: "doctor", summary: "Diagnose runtimes, dependencies, services, env files, git, and terminal support.", usage: "setupr doctor [--plain|--tui] [--fix --yes]", mode: "both", allowsSubcommand: false, options: flagOptions("--plain, --no-tui", "--tui", "--verbose", "--fix", "--yes") },
  { id: "update", name: "update", summary: "Check dependency updates and warn about risky changes.", usage: "setupr update [--plain|--tui|--smart]", mode: "both", allowsSubcommand: false, options: flagOptions("--plain, --no-tui", "--tui", "--smart"), aiCapable: true },
  { id: "clean", name: "clean", summary: "Remove generated artifacts; supports deps, share, and all modes.", usage: "setupr clean [deps|share|all] [--force] [--plain]", mode: "both", allowsSubcommand: true, subcommands: [{ name: "deps", summary: "Remove dependency/install artifacts." }, { name: "share", summary: "Remove local share-sensitive files." }, { name: "all", summary: "Remove dependencies, build output, caches, and local env files." }], options: flagOptions("--deps", "--share", "--all", "--force", "--plain, --no-tui"), risk: "high", writes: true },
  { id: "env", name: "env", summary: "Open the .env editor TUI or manage project .env files from .env.example.", usage: "setupr env [init|check|sync|smart] [--force|--plain]", mode: "both", subcommands: [{ name: "init", summary: "Create .env from .env.example." }, { name: "check", summary: "Report missing values required by .env.example." }, { name: "sync", summary: "Sync .env structure from .env.example." }, { name: "smart", summary: "Analyze missing, invalid, extra, and changed env values." }], options: flagOptions("--force", "--plain, --no-tui", "--tui"), writes: true, aiCapable: true, examples: ["setupr env", "setupr env init", "setupr env --force", "setupr env smart"] },
  { id: "auth", name: "auth", summary: "Manage Setupr AI provider API keys and models.", usage: "setupr auth <command> [options]", mode: "both", subcommands: [{ name: "login", summary: "Guided provider setup." }, { name: "list", summary: "List masked API key status." }, { name: "status", summary: "Show active model and key source." }, { name: "set-key", summary: "Save a provider API key globally." }, { name: "remove", summary: "Remove one saved provider key." }, { name: "test", summary: "Test configured providers." }, { name: "models", summary: "Show supported models." }, { name: "use", summary: "Set active model globally." }, { name: "doctor", summary: "Run auth diagnostics." }, { name: "migrate", summary: "Move provider keys from project .env to global auth." }, { name: "reset", summary: "Remove all saved provider keys." }], options: flagOptions("--key <value>", "--force", "--plain, --no-tui"), writes: true },
  { id: "info", name: "info", summary: "Show project summary.", usage: "setupr info", mode: "plain", allowsSubcommand: false },
  { id: "list", name: "list", summary: "List available project scripts.", usage: "setupr list", mode: "plain", allowsSubcommand: false },
  { id: "run", name: "run", summary: "Run a project script.", usage: "setupr run <script>", mode: "plain" },
  { id: "switch", name: "switch", summary: "Switch runtime version.", usage: "setupr switch <version>", mode: "plain", writes: true },
  { id: "add", name: "add", summary: "Install a dependency using the detected package manager.", usage: "setupr add <package>", mode: "plain", writes: true },
  { id: "remove", name: "remove", summary: "Remove a dependency using the detected package manager.", usage: "setupr remove <package>", mode: "plain", writes: true },
  { id: "port", name: "port", summary: "Check common ports or one specific port.", usage: "setupr port [port]", mode: "plain" },
  { id: "deps", name: "deps", summary: "Show dependency tree, audit, why, and license information.", usage: "setupr deps [list|audit|why|licenses]", mode: "plain", subcommands: [{ name: "list", summary: "Show top-level dependencies." }, { name: "audit", summary: "Summarize npm audit results." }, { name: "why", summary: "Explain why a package is present.", usage: "setupr deps why <package>" }, { name: "licenses", summary: "Flag GPL, AGPL, and LGPL licenses." }], aiCapable: true },
  { id: "config", name: "config", summary: "Manage global Setupr preferences.", usage: "setupr config <show|set|reset|models>", mode: "plain", subcommands: [{ name: "show", summary: "Show current config." }, { name: "set", summary: "Set a preference." }, { name: "reset", summary: "Restore defaults." }, { name: "models", summary: "Show model catalog." }], writes: true },
  { id: "lock", name: "lock", summary: "Snapshot environment state.", usage: "setupr lock", mode: "plain", allowsSubcommand: false, writes: true },
  { id: "diff", name: "diff", summary: "Compare current state with a locked state.", usage: "setupr diff", mode: "plain", allowsSubcommand: false },
  { id: "logs", name: "logs", summary: "Show recent Setupr-managed process logs, falling back to package-manager logs.", usage: "setupr logs [target]", mode: "plain" },
  { id: "test", name: "test", summary: "Run verification suites, smoke checks, and reports.", usage: "setupr test [run|quick|full|ci|smoke|unit|integration|e2e|watch|coverage|changed|file|failed|doctor|list|report|clean|fix|security] [options]", mode: "plain", subcommands: ["run", "quick", "full", "ci", "smoke", "unit", "integration", "e2e", "watch", "coverage", "changed", "file", "failed", "doctor", "list", "report", "clean", "fix", "security"].map((name) => ({ name, summary: `test ${name} workflow.` })), options: flagOptions("--json", "--report <file>", "--yes", "--force", "--watch") },
  { id: "security", name: "security", summary: "Run defensive security scans, baselines, ignores, and safe fixes.", usage: "setupr security [scan|quick|deep|deps|secrets|env|docker|ci|code|routes|auth|headers|doctor|report|baseline|ignore|fix|watch|test] [options]", mode: "plain", subcommands: ["scan", "quick", "deep", "deps", "secrets", "env", "docker", "ci", "code", "routes", "auth", "headers", "doctor", "report", "baseline", "ignore", "fix", "watch", "test"].map((name) => ({ name, summary: `security ${name} check.` })), options: flagOptions("--json", "--report <file>", "--url <url>", "--force", "--yes"), aiCapable: true },
  { id: "fix", name: "fix", summary: "Preview or run grouped safe fixes across doctor, env, lint, format, and security.", usage: "setupr fix [doctor|env|lint|format|security|all] [--yes|--force]", mode: "plain", subcommands: ["doctor", "env", "lint", "format", "security", "all"].map((name) => ({ name, summary: `fix ${name} workflow.` })), options: flagOptions("--yes", "--force"), writes: true, risk: "medium" },
  { id: "release", name: "release", summary: "Run release readiness checks, package dry-runs, notes, and version summaries.", usage: "setupr release [check|publish-check|notes|version] [--json]", mode: "plain", subcommands: ["check", "publish-check", "notes", "version"].map((name) => ({ name, summary: `release ${name}.` })), options: flagOptions("--json"), writes: false },
  { id: "perf", name: "perf", summary: "Measure Setupr startup, scan, context, and status performance.", usage: "setupr perf [startup|scan|context|status] [--json]", mode: "plain", subcommands: ["startup", "scan", "context", "status"].map((name) => ({ name, summary: `perf ${name}.` })), options: flagOptions("--json") },
  { id: "github", name: "github", summary: "Show GitHub repository, Actions, PR, and issue targets for this project.", usage: "setupr github [status|ci|pr|issue] [--remote <name>] [--json]", mode: "plain", subcommands: ["status", "ci", "pr", "issue"].map((name) => ({ name, summary: `github ${name}.` })), options: flagOptions("--json", "--remote <name>"), aiCapable: true },
  { id: "gh", name: "gh", summary: "Alias for setupr github.", usage: "setupr gh [status|ci|pr|issue] [--json]", mode: "plain", subcommands: ["status", "ci", "pr", "issue"].map((name) => ({ name, summary: `gh ${name}.` })), options: flagOptions("--json"), hidden: true },
  { id: "registry", name: "registry", summary: "Look up package registry information for npm, PyPI, and crates.", usage: "setupr registry <npm|pypi|crates> <package>", mode: "plain", subcommands: ["npm", "pypi", "crates"].map((name) => ({ name, summary: `registry ${name}.` })), options: flagOptions("--json") },
  { id: "build", name: "build", summary: "Run the project build script.", usage: "setupr build", mode: "plain", allowsSubcommand: false },
  { id: "deploy", name: "deploy", summary: "Run deploy scripts.", usage: "setupr deploy", mode: "plain", allowsSubcommand: false },
  { id: "open", name: "open", summary: "Open project browser, repository, or IDE target.", usage: "setupr open [repo|ide] [--remote <name>]", mode: "plain", options: flagOptions("--remote <name>") },
  { id: "git", name: "git", summary: "Git workflows, hooks, branches, PRs, and history tools.", usage: "setupr git <command> [options]", mode: "plain", subcommands: ["init", "hooks", "flow", "commit-message", "commit", "pr-description", "branch-check", "conflicts", "branch", "pr", "stash", "rebase", "tag", "release", "status", "log", "sync", "clean", "ignore", "changelog", "blame", "cherry-pick", "worktree", "bisect", "contributors", "undo"].map((name) => ({ name, summary: `git ${name} workflow.` })), options: flagOptions("--force", "--smart", "--remote <name>"), writes: true, aiCapable: true },
  { id: "init", name: "init", summary: "Scaffold a new project from built-in stacks or templates.", usage: "setupr init [stack|name] [--force]", mode: "plain", options: flagOptions("--template <name>", "--force"), writes: true },
  { id: "migrate", name: "migrate", summary: "Migrate package manager metadata and lockfiles.", usage: "setupr migrate <npm|yarn|pnpm|bun> [--force]", mode: "plain", options: flagOptions("--force"), risk: "high", writes: true },
  { id: "ci", name: "ci", summary: "Generate CI/CD configuration.", usage: "setupr ci <github|gitlab|bitbucket|circleci>", mode: "plain", writes: true },
  { id: "docker", name: "docker", summary: "Generate Dockerfile and compose files, or check Docker readiness.", usage: "setupr docker <generate|compose|check> [--force]", mode: "plain", subcommands: [{ name: "generate", summary: "Generate Dockerfile." }, { name: "compose", summary: "Generate docker-compose.yml." }, { name: "check", summary: "Check Docker availability." }], options: flagOptions("--force"), writes: true },
  { id: "secrets", name: "secrets", summary: "Manage encrypted project-local secrets.", usage: "setupr secrets <init|set|get|list|remove|export|import|rotate> [name] [value]", mode: "plain", subcommands: ["init", "set", "get", "list", "remove", "export", "import", "rotate"].map((name) => ({ name, summary: `secrets ${name}.` })), options: flagOptions("--force"), writes: true },
  { id: "templates", name: "templates", summary: "Create, list, save, and remove project templates.", usage: "setupr templates <new|list|save|remove> [name-or-url]", mode: "plain", subcommands: ["new", "list", "save", "remove"].map((name) => ({ name, summary: `templates ${name}.` })), writes: true },
  { id: "workspace", name: "workspace", summary: "Inspect and operate on monorepo workspaces.", usage: "setupr workspace <list|run|exec|add|info|check> [args] [--filter <package>]", mode: "plain", subcommands: ["list", "run", "exec", "add", "info", "check"].map((name) => ({ name, summary: `workspace ${name}.` })), options: flagOptions("--filter <package>"), writes: true },
  { id: "health", name: "health", summary: "Run project health, dependency, security, size, and outdated checks.", usage: "setupr health [full|deps|security|outdated|size]", mode: "plain", subcommands: ["full", "deps", "security", "outdated", "size"].map((name) => ({ name, summary: `health ${name}.` })), aiCapable: true },
  { id: "share", name: "share", summary: "Export, import, or inspect shareable project setup bundles.", usage: "setupr share <export|import|inspect> [file]", mode: "plain", subcommands: ["export", "import", "inspect"].map((name) => ({ name, summary: `share ${name}.` })), writes: true },
  { id: "notes", name: "notes", summary: "Manage deterministic project-local notes in .setupr.", usage: "setupr notes <add|list|remove|clear> [text-or-id]", mode: "plain", subcommands: ["add", "list", "remove", "clear"].map((name) => ({ name, summary: `notes ${name}.` })), options: flagOptions("--json", "--force"), writes: true },
  { id: "history", name: "history", summary: "Show recent project-local Setupr history.", usage: "setupr history [list] [limit] [--json]", mode: "plain", subcommands: [{ name: "list", summary: "List recent history events." }], options: flagOptions("--json") },
  { id: "context", name: "context", summary: "Export or import project notes and history for team handoff.", usage: "setupr context <show|export|import> [file]", mode: "plain", subcommands: ["show", "export", "import"].map((name) => ({ name, summary: `context ${name}.` })), options: flagOptions("--json"), writes: true },
  { id: "plugin", name: "plugin", summary: "Create, validate, install, inspect, enable, or disable Setupr plugins.", usage: "setupr plugin <create|validate|doctor|install|remove|list|info|enable|disable> [name-or-url]", mode: "plain", subcommands: ["create", "validate", "doctor", "install", "remove", "list", "info", "enable", "disable"].map((name) => ({ name, summary: `plugin ${name}.` })), writes: true },
  { id: "lint", name: "lint", summary: "Run, fix, or set up linting.", usage: "setupr lint <run|setup|fix> [--force]", mode: "plain", subcommands: ["run", "setup", "fix"].map((name) => ({ name, summary: `lint ${name}.` })), options: flagOptions("--force"), writes: true },
  { id: "format", name: "format", summary: "Run, check, or set up formatting.", usage: "setupr format <run|check|setup> [--force]", mode: "plain", subcommands: ["run", "check", "setup"].map((name) => ({ name, summary: `format ${name}.` })), options: flagOptions("--force"), writes: true },
  { id: "scaffold", name: "scaffold", summary: "Advanced project-file generation for existing local workflows.", usage: "setupr scaffold <component|page|api|hook|model|test|service|middleware> <name>", mode: "plain", subcommands: ["component", "page", "api", "hook", "model", "test", "service", "middleware"].map((name) => ({ name, summary: `scaffold ${name}.` })), writes: true, showInGlobalHelp: false },
  { id: "analyze", name: "analyze", summary: "Advanced project architecture inspection.", usage: "setupr analyze", mode: "plain", allowsSubcommand: false, showInGlobalHelp: false },
  { id: "explain", name: "explain", summary: "Advanced file explanation from deterministic code signals.", usage: "setupr explain <file>", mode: "plain", showInGlobalHelp: false },
  { id: "refactor", name: "refactor", summary: "Advanced refactor suggestions for a file.", usage: "setupr refactor <file>", mode: "plain", showInGlobalHelp: false },
  { id: "todo", name: "todo", summary: "Advanced TODO/FIXME/HACK inspection.", usage: "setupr todo", mode: "plain", allowsSubcommand: false, showInGlobalHelp: false },
  { id: "help", name: "help", summary: "Show global or command-specific help.", usage: "setupr help [command] [subcommand]", mode: "plain", allowsSubcommand: true },
];

export function visibleCommands(): CommandEntry[] {
  return COMMAND_REGISTRY.filter((command) => !command.hidden);
}

export function publicCommands(): CommandEntry[] {
  return visibleCommands().filter((command) => command.showInGlobalHelp !== false);
}

export function getCommand(idOrName: string): CommandEntry | undefined {
  return COMMAND_REGISTRY.find((command) => command.id === idOrName || command.name === idOrName);
}

export function knownCommandNames(): Set<string> {
  return new Set(visibleCommands().map((command) => command.name));
}

export function tuiCommandNames(): Set<string> {
  return new Set(visibleCommands().filter((command) => command.mode === "tui" || command.mode === "both").map((command) => command.name));
}

export function noSubcommandNames(): Set<string> {
  return new Set(visibleCommands().filter((command) => command.allowsSubcommand === false).map((command) => command.name));
}

function flagOptions(...names: string[]): CommandOption[] {
  return names.map((name) => GLOBAL_OPTIONS.find((option) => option.name === name) || { name, summary: "Command-specific option." });
}
