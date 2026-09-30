# Commands

Full reference of all Setupr CLI commands.

## Explain a Command Result

Append `--explain` to a plain command to show its normal result first, then request a concise AI explanation:

```bash
setupr info --explain
setupr env check --plain --explain
setupr doctor --plain --explain
setupr status --json --explain
```

This flag selects plain output and cannot be combined with `--tui`. The explanation goes to stderr, including with `--json`, so stdout keeps its original format. The original exit status is preserved. Explanations are advisory: they do not run repairs or change files. No provider key, disabled AI, or a failed AI request produces a notice rather than hiding the command result.

One additional provider request is allowed per explanation, with a 30-second timeout and no retries. `--smart` and `chat` do not request a duplicate explanation. `auth`, `secrets`, and `config` never send their output to this feature. The request contains a bounded, redacted command-output excerpt, not an unrestricted project scan. Known provider credentials, sensitive environment values, assignments, credential URLs, and private keys are filtered; review arbitrary custom-script output before sending it to any external provider. Child processes that write directly to inherited file descriptors may not be captured. Watching commands are explained only after they return normally.

## Rich Replies and Secret Reveal

AI replies in TUIs render Markdown headings, bold/italic emphasis, lists, code blocks, and links. Tables become labeled records to stay readable in narrow panels. The pending-message indicator animates; Esc cancels a pending reply. Scroll over the transcript or use PageUp/PageDown to read earlier output. Chat/setup transcripts use the actual space remaining above the bottom-anchored input.

In the env editor, click **Show (Ctrl+R)** or press **Ctrl+R** in the selected sensitive field to reveal it. Click **Hide** or repeat the shortcut to mask it. Leaving the field, selecting another variable, resizing, or waiting 30 seconds masks it again. Revealing is display-only; it does not save a value or expose it in other panels. Masking is not encryption: `.env` files themselves are plaintext.

`status --json` uses `null` for `health.score`, `security.score`, and
`security.findings` when a security assessment is absent or unavailable. Do not
interpret missing measurements as a perfect score or zero findings. Plain/TUI
views show `N/A`; run `setupr security scan` to produce an assessment.

## TUI Commands (Rich Interactive UI)

| Command | Description |
|---------|-------------|
| `setupr` / `dashboard` | Project dashboard with health, git, env, processes, history, and quick commands |
| `setup` | Full project setup — scan, install runtime, deps, env, verify |
| `chat <question>` | AI director chat TUI for project questions, steering, plans, logs, and context |
| `status` | Dashboard/status view with plain, JSON, or TUI output |
| `start` | Start and track a managed project process |
| `doctor` | Diagnose environment health (runtimes, deps, ports) |
| `update` | Check for dependency updates with breaking change warnings |
| `clean` | Review and remove artifacts (`--deps`, `--share`, `--all`; positional `deps`, `share`, `all` also work) |
| `env` | Open the .env editor TUI or manage project .env files from .env.example |
| `auth` | Manage global Setupr AI provider API keys and models |

## Non-TUI Commands (Plain Terminal)

| Command | Description |
|---------|-------------|
| `env init\|check\|sync\|smart` | Manage .env files in plain mode with subcommands |
| `ps` | List Setupr-managed processes |
| `stop [target]` | Stop one or all managed processes |
| `restart [target]` | Restart a managed process |
| `info` | Show project summary |
| `list` | List available scripts/commands |
| `run <script>` | Run a project script |
| `switch <version>` | Switch runtime version |
| `add <package>` | Smart add dependency |
| `remove <package>` | Remove dependency |
| `port [number]` | Check/find/kill port |
| `deps [list\|audit\|why\|licenses]` | Dependency tree, audit summary, package reasoning, and license checks |
| `config` | Manage setupr config |
| `help [command]` | Show global or command-specific help |
| `lock` | Snapshot environment state |
| `diff` | Compare current vs locked state |
| `logs [target]` | Show managed process logs, falling back to package-manager logs |
| `test [run\|quick\|full\|ci\|smoke\|unit\|integration\|e2e\|watch\|coverage\|changed\|file\|failed\|doctor\|list\|report\|clean\|fix\|security]` | Run verification suites, smoke checks, and reports |
| `security [scan\|quick\|deep\|deps\|secrets\|env\|docker\|ci\|code\|routes\|auth\|headers\|doctor\|report\|baseline\|ignore\|fix\|watch\|test]` | Run defensive security scans, baselines, ignores, and safe fixes |
| `fix [doctor\|env\|lint\|format\|security\|all]` | Preview or run grouped safe fixes |
| `release [check\|publish-check\|notes\|version]` | Release readiness checks, package dry-runs, notes, and version summaries |
| `perf [startup\|scan\|context\|status]` | Measure Setupr scan/context/status performance |
| `github [status\|ci\|pr\|issue]` | Show GitHub repository, Actions, PR, and issue targets |
| `registry <npm\|pypi\|crates> <package>` | Look up package registry information |
| `build` | Detect and run build command |
| `deploy` | Run deploy scripts |
| `open [repo\|ide]` | Open in browser/IDE/repo |
| `git` | Git workflows plus commit-message, PR-description, branch-check, and conflict helper |
| `init` | Scaffold new projects from stacks or templates |
| `migrate <npm\|yarn\|pnpm\|bun>` | Migrate package manager metadata and lockfiles |
| `ci <github\|gitlab\|bitbucket\|circleci>` | Generate CI/CD config |
| `docker <generate\|compose\|check>` | Generate Dockerfile/compose files or check Docker readiness |
| `secrets <init\|set\|get\|list\|remove\|export\|import\|rotate>` | Manage encrypted project-local secrets |
| `templates <new\|list\|save\|remove>` | Create, save, list, or remove templates |
| `workspace <list\|run\|exec\|add\|info\|check>` | Operate on monorepo workspaces |
| `health [full\|deps\|security\|outdated\|size]` | Run project health checks |
| `share <export\|import\|inspect>` | Export/import shareable setup bundles |
| `notes <add\|list\|remove\|clear>` | Manage project-local notes in `.setupr` |
| `history [list] [limit]` | Show recent project-local Setupr history |
| `context <show\|export\|import>` | Export/import notes and history for team handoff |
| `plugin <create\|validate\|doctor\|install\|remove\|list\|info\|enable\|disable>` | Manage Setupr plugins and plugin development |
| `lint <run\|setup\|fix>` | Run or set up linting |
| `format <run\|check\|setup>` | Run or set up formatting |

## Flags

| Flag | Description |
|------|-------------|
| `--force` | Skip safe prompts, install what project specifies, and stop only for blockers or destructive choices |
| `--no-tui` / `--plain` | Plain terminal output for CI/CD, piping, SSH |
| `--deps` | With `clean`, remove dependency/cache artifacts |
| `--share` | With `clean`, remove sensitive/local-only files before sharing a project |
| `--all` | With `clean`, remove dependencies, build output, caches, and local env files |
| `--json` | Emit machine-readable JSON where a command supports it (`status`, `ps`, `release`, `perf`, `github`, …) |
| `--cwd <path>` | Run against another project directory; Setupr errors if the path does not exist or is not a directory |
| `--remote <name>` | Select the remote for `github`, `git pr`, `git sync`, or `open repo`; unknown names fail instead of falling back |
| `--filter <package>` | Filter `workspace run` and `workspace exec` by package name or relative path |

Run `setupr help` for the full global option list, or `setupr help <command>` for a command's own flags and examples.

### Multiple Remotes

`setupr github` selects a GitHub `origin`, then GitHub `upstream`, then another GitHub remote in name order.
GitLab/local remotes do not prevent finding an available GitHub upstream. `--remote` selects exactly
one remote. GitHub commands recognize public `github.com` HTTPS, SSH, SCP-style URLs, and
`ssh.github.com:443`; SSH aliases and GitHub Enterprise hosts are not inferred.

`git sync` respects existing Git tracking and push configuration. An ambiguous first push requires
an explicit remote. A failed pull prevents the push. Remote credentials are omitted from displayed
URLs, history/context, and operation errors.

### Workspace and Env Safety

Workspace globs are deduplicated and exclusions are honored. Malformed configs, parent-directory
patterns, and symlinks outside the project fail before workspace commands run. `workspace add`
creates a new package; it never overwrites an existing directory, including with `--force`.
`workspace run` uses the root package manager and reports failed or unmatched targets with a nonzero exit.

`env sync` appends missing template keys without replacing existing values, intentional blanks,
comments, multiline values, or extra variables. `env smart` masks sensitive values and saves only
after unresolved issues have been addressed. Env updates reject conflicting concurrent edits,
symlinks, and values that cannot be safely serialized. `env init --force` without a template
does not erase an existing `.env`.

## TUI Navigation

- **Arrow keys**: Move between neighboring panels in the dashboard
- **Tab / Shift+Tab**: Move to the next or previous focusable panel
- **Mouse click**: Focus a panel in terminals that support SGR mouse events
- **Mouse click inside focused input**: Move the text cursor where the terminal reports coordinates accurately
- **Option/Alt+Arrow**: Move by word where the terminal sends a compatible sequence
- **Backspace / Mac Delete**: Delete the previous character
- **Fn+Delete / Ctrl+D**: Delete the next character
- **Option/Alt+Delete or Ctrl+W**: Delete the previous word
- **Ctrl+Delete / Option+Fn+Delete**: Delete the next word where supported by the terminal
- **Ctrl+A / Ctrl+E**: Jump to start/end of input
- **Ctrl+U / Ctrl+K**: Clear before/after cursor
- **Enter**: Confirm / submit focused inputs
- **Esc**: Leave or skip the active input when supported
- **Esc during an AI reply**: Cancel that reply; this does not cancel an executing setup step or stop a managed process
- **Mouse wheel over setup/chat transcript / PgUp/PgDn while its panel is focused**: Read earlier or later reply lines
- **q**: Quit when focus is not inside an input

The TUI runs in the terminal alternate screen, so exiting returns to the original shell history instead of leaving the dashboard printed in the scrollback. It enables SGR mouse reporting and bracketed paste while active, then disables both on cleanup. It does not set a background color; Terminal, iTerm2, Ghostty, and other terminal profiles keep control of their own theme/background. Panels are drawn with Unicode box-drawing characters because terminal UIs render in character cells rather than graphical window primitives. TUIs require at least a `60x18` terminal grid; smaller windows show a resize notice rather than squeezing panels until borders collapse.

Conversational AI requests show the provider/model or retry progress and elapsed time. They have
a 60-second total budget and try at most two fallback models after a retryable failure. Escape
cancels the request; send a new message to retry. Completed responses appear when the provider
returns, not as streamed tokens. Private reasoning is not displayed. A fallback answer identifies
the model used and does not change the saved default model.

Setupr TUIs share the same terminal-native style: blue uppercase panel titles, thin blue borders, yellow focused borders/actions, green success states, yellow warnings/current work, and red failures. Interactive inputs stay anchored at the bottom of their panel, wrap within the box, and scroll once long input reaches the panel's line cap. If a terminal font/profile leaves visible gaps in thin Unicode box drawing, run with `SETUPR_TUI_BORDER=bold`, `double`, `round`, or `classic`. `setupr clean` opens a safety review first; type `CLEAN` to delete reviewed targets, or use `--force` only when you intentionally want Setupr to skip the review prompt.

## Help

```bash
setup help
setup help auth
setupr auth --help
setup help auth set-key
```

Global help lists every command. Command help shows subcommands, variations, options, and examples for that command.
