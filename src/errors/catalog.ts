import type { SetuprErrorCode, SetuprErrorInput, SetuprErrorCategory, SetuprErrorSeverity } from "./types.js";

type Template = Omit<SetuprErrorInput, "code" | "command" | "subcommand" | "cwd" | "metadata" | "cause">;

export const ERROR_CATALOG: Record<SetuprErrorCode, Template> = {
  UNKNOWN_COMMAND: usage("Unknown command", "Setupr does not have a command with that name.", ["Run setup help to see every available command."]),
  UNKNOWN_SUBCOMMAND: usage("Unknown subcommand", "That subcommand is not available for this command.", ["Run setup help <command> to see valid subcommands."]),
  INVALID_FLAG: usage("Flag is not valid here", "The flag was accepted by the shell parser but does not apply to this command.", ["Remove the flag or run setup help <command>."]),
  INVALID_FLAG_COMBINATION: usage("Flags conflict", "Two or more flags request incompatible behavior.", ["Pick one mode and rerun the command."]),
  INVALID_CWD: usage("Directory not found", "The path passed with --cwd does not exist or is not a directory.", ["Check the path and rerun with a valid --cwd, or omit it to use the current directory."]),
  MISSING_PACKAGE: usage("Package name required", "This command needs a package name to act on.", ["Pass a package, e.g. setup add <package> or setup remove <package>."]),
  INVALID_ARGUMENT: usage("Invalid argument", "An argument passed to this command is not valid.", ["Check the argument format and rerun, or run setup help <command>."]),
  NON_INTERACTIVE_CONFIRMATION_REQUIRED: usage("Confirmation required", "This action needs confirmation, but the current terminal cannot accept interactive input.", ["Rerun in an interactive terminal or pass --force if you accept the risk."]),
  NON_INTERACTIVE_INPUT_REQUIRED: usage("Input required", "This command needs a value, but the current terminal cannot prompt for it.", ["Pass the value as an option, or rerun in an interactive terminal."]),

  NO_PROJECT_DETECTED: project("No project detected", "This directory does not contain recognizable project files.", ["Open a folder with package.json, pyproject.toml, Cargo.toml, go.mod, or similar."]),
  MALFORMED_PROJECT_FILE: project("Project file could not be parsed", "A project/config file exists but is malformed.", ["Fix the file syntax and rerun the command."]),
  PROJECT_CONFIG_INVALID: config("Setupr project config is invalid", "A Setupr config file exists but does not match the expected shape.", ["Fix the config or remove it to let Setupr auto-detect."]),
  MISSING_PACKAGE_JSON: project("package.json missing", "This command needs package.json but none was found.", ["Run this from a JavaScript project root."]),
  MISSING_PACKAGE_MANAGER: pkg("Package manager missing", "The detected package manager is not installed or not available on PATH.", ["Install the package manager or switch to one that is available."]),
  MISSING_SCRIPT: project("Script missing", "The requested package script does not exist.", ["Add the script to package.json or choose another script."]),
  MISSING_RUNTIME: runtime("Runtime missing", "The project runtime is not installed or not available on PATH.", ["Install the runtime and rerun doctor/setup."]),

  ENV_TEMPLATE_MISSING: env("No .env.example found", "Setupr cannot infer the app's environment variables without a template.", ["Create .env.example, or rerun with --force to create an empty .env."]),
  ENV_FILE_MISSING: env("No .env file found", "Setupr found an environment template, but there is no editable .env file yet.", ["Run setupr env init, or run setupr env and confirm creation from .env.example."]),
  ENV_ALREADY_EXISTS: envWarn("Existing .env left unchanged", ".env already exists, so Setupr did not overwrite it.", ["Use --force if you intentionally want to overwrite it."]),
  ENV_SYNC_FAILED: env("Env sync failed", "Setupr could not sync .env with .env.example.", ["Check file permissions and .env.example syntax."]),
  ENV_CHECK_FAILED: env("Env check failed", "Setupr found missing or empty environment values.", ["Fill the missing values in .env."]),
  ENV_SMART_FAILED: env("Env smart analysis failed", "Setupr could not complete smart env analysis.", ["Fix the reported env issues, rerun interactively, or update .env manually."]),
  ENV_WRITE_FAILED: fs("Could not write env file", "Setupr could not create or update the env file.", ["Check file permissions and whether .env is a directory or locked file."]),
  ENV_INVALID_VALUE: envWarn("Environment value looks invalid", "One or more values look like placeholders or invalid formats.", ["Replace placeholders with real values."]),
  ENV_DUPLICATE_KEY: envWarn("Duplicate environment key", "The same environment key appeared more than once.", ["Keep one value for each key."]),

  AUTH_PROVIDER_REQUIRED: auth("Provider required", "This auth command needs a provider name.", ["Use one of: openai, anthropic, google, groq, minimax, moonshot, github."]),
  AUTH_PROVIDER_UNKNOWN: auth("Unknown provider", "Setupr does not recognize that AI provider.", ["Run setupr auth models to see supported providers."]),
  AUTH_KEY_MISSING: auth("API key missing", "The selected provider does not have a configured API key.", ["Run setupr auth set-key <provider>."]),
  AUTH_KEY_EMPTY: auth("API key empty", "No API key was entered, so nothing was saved.", ["Rerun setupr auth set-key <provider>."]),
  AUTH_KEY_REPLACE_CANCELLED: info("auth", "Auth key unchanged", "You cancelled replacing the existing key.", ["No action is needed."]),
  AUTH_STORAGE_FAILED: fs("Auth storage failed", "Setupr could not read or write global auth storage.", ["Check ~/.setupr permissions."]),
  AUTH_STORAGE_INVALID: auth("Auth storage is invalid", "The saved auth file could not be parsed safely, so Setupr stopped instead of treating keys as missing.", ["Fix or remove ~/.setupr/secrets.json, then rerun setupr auth doctor."]),
  AUTH_MIGRATION_FAILED: auth("Auth migration failed", "Setupr could not migrate provider keys out of project .env.", ["Check file permissions and rerun setupr auth migrate."]),

  AI_MODEL_REQUIRED: ai("Model required", "This command needs a model id.", ["Run setupr auth models, then setupr auth use <model>."]),
  AI_MODEL_UNKNOWN: ai("Unknown AI model", "The requested model is not in the catalog and is not a valid GitHub Models id.", ["Run setupr auth models."]),
  AI_MODEL_UNAVAILABLE: ai("AI model unavailable", "The model exists, but its provider is not configured.", ["Configure the provider key or choose an available model."]),
  AI_KEY_MISSING: ai("AI key missing", "AI features need a configured provider key.", ["Run setupr auth login or setupr auth set-key <provider>."]),
  AI_PROVIDER_TIMEOUT: provider("AI provider timed out", "The provider did not respond before the timeout.", ["Retry, switch models, or continue without AI."]),
  AI_PROVIDER_AUTH_FAILED: provider("AI provider rejected the key", "The provider returned an authentication or authorization error.", ["Replace the key or check provider access."]),
  AI_PROVIDER_RATE_LIMITED: provider("AI provider rate-limited the request", "The provider is asking Setupr to slow down.", ["Wait and retry, or switch to another configured provider."]),
  AI_PROVIDER_QUOTA_EXHAUSTED: provider("AI credits or quota exhausted", "The provider says the account has no remaining quota or credits.", ["Add credits, switch model/provider, or continue without AI."]),
  AI_PROVIDER_UNAVAILABLE: provider("AI provider unavailable", "The provider returned a server or service error.", ["Retry later or switch to another provider."]),
  AI_PROVIDER_PROTOCOL_ERROR: provider("AI provider response was invalid", "The provider returned a response Setupr could not understand.", ["Retry or switch provider."]),
  AI_PROVIDER_REQUEST_FAILED: provider("AI request failed", "The AI provider request failed.", ["Retry, switch provider, or continue without AI."]),

  COMMAND_FAILED: executor("Command failed", "A command exited with a non-zero status.", ["Read the command output, fix the underlying issue, and rerun."]),
  COMMAND_NOT_FOUND: executor("Command not found", "The shell could not find the command to run.", ["Install the missing tool or fix PATH."]),
  COMMAND_TIMEOUT: executor("Command timed out", "The command took too long and was stopped.", ["Retry, check network/service state, or run the command manually."]),
  COMMAND_ABORTED: executor("Command aborted", "The command was interrupted before it finished.", ["Rerun when ready."]),
  PROCESS_ALREADY_RUNNING: executor("Process already running", "Setupr is already managing a live process with that name.", ["Run setupr ps, setupr logs, or setupr stop before starting another."]),
  PROCESS_NOT_FOUND: executor("Process not found", "Setupr could not find a managed process with that name.", ["Run setupr ps to list managed processes."]),
  INSTALL_FAILED: executor("Dependency install failed", "The package manager failed while installing dependencies.", ["Check package manager output, network, lockfile, and dependency conflicts."]),
  BUILD_FAILED: executor("Build failed", "The project's build command failed.", ["Fix the build error, then rerun setup build or setup."]),
  TEST_FAILED: executor("Tests failed", "The project's test command failed.", ["Fix failing tests, then rerun setupr test."]),
  UPDATE_CHECK_FAILED: pkg("Update check failed", "Setupr could not check outdated packages.", ["Check package manager availability and registry/network access."]),
  CLEAN_TARGET_FAILED: fs("Clean target failed", "Setupr could not remove one of the requested files or folders.", ["Check permissions or close processes using the file."]),
  CLEAN_MODE_INVALID: usage("Invalid clean mode", "Clean mode must be deps, share, or all.", ["Run setupr clean --deps, setupr clean --share, or setupr clean --all."]),
  PORT_CHECK_FAILED: executor("Port check failed", "Setupr could not inspect the requested port.", ["Check platform tools such as lsof/netstat."]),
  LOCK_STATE_MISSING: info("config", "No locked state found", "There is no saved environment lock to compare against.", ["Run setup lock first."]),
  LOG_FILE_MISSING: fs("No log file found", "Setupr could not find a known package-manager or Setupr log file in this project.", ["Run the failing command again, or check package-manager logs manually."]),
  OPEN_TARGET_MISSING: project("Open target missing", "Setupr could not find the requested URL, remote, or local app target.", ["Check project metadata and rerun."]),

  TUI_TERMINAL_TOO_SMALL: tui("Terminal too small", "The current terminal is too small to render the full TUI.", ["Resize the terminal or run with --plain."]),
  TUI_MOUSE_PROTOCOL_LEFT_ON: tui("Mouse reporting left on", "The terminal appears to be emitting mouse escape reports.", ["Reset the terminal or restart the shell."]),
  TUI_RENDER_FAILED: tui("TUI render failed", "The terminal UI could not render safely.", ["Rerun with --plain and report the terminal size."]),
  FILESYSTEM_PERMISSION_DENIED: fs("Permission denied", "The operating system refused a file operation.", ["Check ownership and permissions."]),
  FILESYSTEM_READ_ONLY: fs("Filesystem is read-only", "Setupr cannot write to this location.", ["Move the project or change filesystem permissions."]),
  NETWORK_UNAVAILABLE: network("Network unavailable", "A network request failed before the service could respond.", ["Check internet/VPN/proxy settings."]),

  GIT_NOT_INSTALLED: git("Git not installed", "Git is not available on PATH.", ["Install git and rerun."]),
  GIT_NOT_A_REPO: git("Not a git repository", "This directory is not inside a git repository.", ["Run setupr git init or git init."]),
  GIT_DIRTY_WORKING_TREE: git("Uncommitted changes", "The working tree has uncommitted changes that would be lost.", ["Commit or stash changes first."]),
  GIT_BRANCH_EXISTS: git("Branch already exists", "A branch with that name already exists.", ["Choose a different name or delete the existing branch."]),
  GIT_MERGE_CONFLICT: git("Merge conflict", "Git encountered merge conflicts that must be resolved manually.", ["Resolve conflicts, then run git add and git commit."]),
  GIT_PUSH_FAILED: git("Push failed", "Git could not push to the remote.", ["Check remote access and branch protection rules."]),
  GIT_REMOTE_MISSING: git("No matching remote configured", "No usable remote matches this command or the requested remote name.", ["Run git remote -v to inspect remotes.", "Select an existing remote with --remote <name> where supported, or add one with git remote add <name> <url>."]),
  GIT_HOOK_FAILED: git("Git hook failed", "A git hook exited with an error.", ["Fix the hook issue or use --no-verify to skip."]),
  GIT_COMMAND_FAILED: git("Git command failed", "A git command exited with a non-zero status.", ["Check the git output for details."]),

  PLUGIN_NOT_FOUND: plugin("Plugin not found", "The requested plugin is not installed.", ["Run setupr plugin install <name>."]),
  PLUGIN_INVALID: plugin("Plugin invalid", "The plugin does not export the required interface.", ["Check the plugin README for compatibility."]),
  PLUGIN_LOAD_FAILED: plugin("Plugin failed to load", "The plugin threw an error during initialization.", ["Check plugin logs and version compatibility."]),
  PLUGIN_REGISTRY_FAILED: plugin("Plugin registry unreachable", "Could not fetch plugin list from the registry.", ["Check network access."]),

  MIGRATE_UNSUPPORTED: migration("Migration not supported", "Setupr cannot migrate between these package managers.", ["Check supported migrations: npm↔yarn↔pnpm↔bun."]),
  MIGRATE_LOCKFILE_CONFLICT: migration("Lockfile conflict", "Multiple lockfiles exist, which could cause conflicts.", ["Remove the old lockfile before migrating."]),
  MIGRATE_FAILED: migration("Migration failed", "The package manager migration did not complete successfully.", ["Check output and manually resolve conflicts."]),

  CI_PLATFORM_UNKNOWN: ci("CI platform not recognized", "Setupr could not detect or does not support this CI platform.", ["Specify platform: github, gitlab, bitbucket, circleci."]),
  CI_GENERATE_FAILED: ci("CI config generation failed", "Setupr could not generate a valid CI configuration.", ["Check project structure and try a different platform."]),

  DOCKER_NOT_INSTALLED: docker("Docker not installed", "Docker CLI is not available on PATH.", ["Install Docker and rerun."]),
  DOCKER_GENERATE_FAILED: docker("Dockerfile generation failed", "Setupr could not generate a Dockerfile for this project.", ["Check detected language/framework and try manually."]),

  SECRETS_ENCRYPTION_FAILED: secrets("Encryption failed", "Setupr could not encrypt the secrets file.", ["Check that the encryption key is set."]),
  SECRETS_DECRYPTION_FAILED: secrets("Decryption failed", "Setupr could not decrypt the secrets file.", ["Verify the correct key is set."]),
  SECRETS_KEY_MISSING: secrets("Encryption key missing", "No encryption key is configured for secrets.", ["Run setupr secrets init to generate a key."]),
  SECRETS_FILE_CORRUPT: secrets("Secrets file corrupt", "The encrypted secrets file could not be parsed.", ["Restore from backup or reinitialize."]),

  TEMPLATE_NOT_FOUND: template("Template not found", "The requested project template does not exist.", ["Run setup template list to see available templates."]),
  TEMPLATE_FETCH_FAILED: template("Template fetch failed", "Could not download the template from the remote source.", ["Check network and URL."]),
  TEMPLATE_INVALID: template("Template invalid", "The template does not have a valid structure.", ["Check the template repository for a valid setupr template."]),

  WORKSPACE_NO_PACKAGES: workspace("No workspace packages found", "Setupr could not find packages in this workspace.", ["Ensure workspace config lists package paths."]),
  WORKSPACE_COMMAND_FAILED: workspace("Workspace command failed", "A command failed in one or more workspace packages.", ["Check individual package errors."]),

  HEALTH_CHECK_FAILED: executor("Health check failed", "One or more health checks did not pass.", ["Review the failing checks and fix issues."]),

  SHARE_EXPORT_FAILED: fs("Share export failed", "Setupr could not export the project configuration.", ["Check file permissions."]),
  SHARE_IMPORT_FAILED: fs("Share import failed", "Setupr could not import the shared configuration.", ["Check the config file format."]),

  INIT_ALREADY_EXISTS: project("Project already initialized", "This directory already contains project files.", ["Use --force to reinitialize."]),
  INIT_TEMPLATE_FAILED: project("Init template failed", "Setupr could not scaffold the project from the selected template.", ["Check network and template availability."]),

  TELEMETRY_SEND_FAILED: info("telemetry", "Telemetry send failed", "Anonymous usage data could not be sent.", ["This is not critical; Setupr continues normally."]),

  UPDATE_AVAILABLE: info("config", "Update available", "A newer version of Setupr is available.", ["Run npm install -g @evan-coder/setupr to update."]),
  UPDATE_FETCH_FAILED: network("Update check failed", "Setupr could not check for updates.", ["Check network access."]),

  AI_RETRY_EXHAUSTED: provider("AI retries exhausted", "All retry attempts to the AI provider have failed.", ["Try again later, switch providers, or continue without AI."]),

  UNKNOWN_ERROR: fatal("Unexpected error", "Setupr hit an unexpected failure.", ["Rerun with debug logs or report the command and project state."]),
};

function entry(category: SetuprErrorCategory, severity: SetuprErrorSeverity, title: string, explanation: string, nextSteps: string[], canContinue = false): Template {
  return { category, severity, title, explanation, nextSteps, canContinue, exitCode: severity === "info" || severity === "warning" ? 0 : 1 };
}
function usage(title: string, explanation: string, nextSteps: string[]) { return entry("usage", "error", title, explanation, nextSteps); }
function project(title: string, explanation: string, nextSteps: string[]) { return entry("project", "error", title, explanation, nextSteps); }
function config(title: string, explanation: string, nextSteps: string[]) { return entry("config", "warning", title, explanation, nextSteps, true); }
function env(title: string, explanation: string, nextSteps: string[]) { return entry("env", "error", title, explanation, nextSteps); }
function envWarn(title: string, explanation: string, nextSteps: string[]) { return entry("env", "warning", title, explanation, nextSteps, true); }
function auth(title: string, explanation: string, nextSteps: string[]) { return entry("auth", "error", title, explanation, nextSteps); }
function ai(title: string, explanation: string, nextSteps: string[]) { return entry("ai", "error", title, explanation, nextSteps, true); }
function provider(title: string, explanation: string, nextSteps: string[]) { return entry("provider", "error", title, explanation, nextSteps, true); }
function runtime(title: string, explanation: string, nextSteps: string[]) { return entry("runtime", "error", title, explanation, nextSteps); }
function pkg(title: string, explanation: string, nextSteps: string[]) { return entry("package-manager", "error", title, explanation, nextSteps); }
function fs(title: string, explanation: string, nextSteps: string[]) { return entry("filesystem", "error", title, explanation, nextSteps); }
function executor(title: string, explanation: string, nextSteps: string[]) { return entry("executor", "error", title, explanation, nextSteps); }
function tui(title: string, explanation: string, nextSteps: string[]) { return entry("tui", "warning", title, explanation, nextSteps, true); }
function network(title: string, explanation: string, nextSteps: string[]) { return entry("network", "error", title, explanation, nextSteps, true); }
function git(title: string, explanation: string, nextSteps: string[]) { return entry("git", "error", title, explanation, nextSteps); }
function plugin(title: string, explanation: string, nextSteps: string[]) { return entry("plugin", "error", title, explanation, nextSteps); }
function migration(title: string, explanation: string, nextSteps: string[]) { return entry("migration", "error", title, explanation, nextSteps); }
function ci(title: string, explanation: string, nextSteps: string[]) { return entry("ci", "error", title, explanation, nextSteps); }
function docker(title: string, explanation: string, nextSteps: string[]) { return entry("docker", "error", title, explanation, nextSteps); }
function secrets(title: string, explanation: string, nextSteps: string[]) { return entry("secrets", "error", title, explanation, nextSteps); }
function template(title: string, explanation: string, nextSteps: string[]) { return entry("template", "error", title, explanation, nextSteps); }
function workspace(title: string, explanation: string, nextSteps: string[]) { return entry("workspace", "error", title, explanation, nextSteps); }
function info(category: SetuprErrorCategory, title: string, explanation: string, nextSteps: string[]) { return entry(category, "info", title, explanation, nextSteps, true); }
function fatal(title: string, explanation: string, nextSteps: string[]) { return entry("unknown", "fatal", title, explanation, nextSteps); }
