# Troubleshooting

## Common Issues

### "Cannot find module" errors

**Cause**: Dependencies not installed or build not run.

**Fix**:
```bash
npm install
npm run build
```

### TUI doesn't render properly

**Cause**: Terminal doesn't support Unicode, the alternate screen buffer, or SGR mouse reporting.

**Fix**: Use `--plain` flag for basic terminal output:
```bash
setupr --plain
```

For the full TUI, use a modern terminal such as Terminal.app, iTerm2, Ghostty, WezTerm, Alacritty, or Kitty. Setupr does not force a background color; it inherits the active terminal profile. If the screen looks stuck after an interrupted run, reset the terminal with:

```bash
printf '\033[0m\033[?1000l\033[?1006l\033[?25h\033[?1049l'
clear
```

The TUI uses Unicode box-drawing characters. Small visual gaps in vertical lines usually come from the terminal font or line-height settings rather than Setupr drawing separate graphical rectangles. Setupr keeps panel coordinates inside the terminal grid and switches to a resize notice below `60x18`. If your terminal profile still shows gaps, use a stronger border style:

```bash
SETUPR_TUI_BORDER=bold setupr
SETUPR_TUI_BORDER=classic setupr setup
```

Supported values are `bold`, `double`, `round`, and `classic`/`ascii`.

### Mouse or scroll codes appear in the input

If you see text like `[<0;78;17m` after clicking or scrolling, the terminal left mouse reporting enabled after an interrupted process. Setupr disables mouse reporting on exit and strips those reports from inputs, but you can manually reset the terminal with:

```bash
printf '\033[?1000l\033[?1002l\033[?1003l\033[?1006l'
```

Modern Terminal.app, iTerm2, and Ghostty all support the mouse protocol Setupr uses.

Setupr also enables bracketed paste while the TUI is active so pasted multi-line env values or chat text are handled as text instead of accidental commands. If a terminal is left in paste mode after a hard crash, reset it with:

```bash
printf '\033[?2004l'
```

Inside focused input boxes, Setupr supports common terminal editing shortcuts where the terminal sends compatible sequences: `Ctrl+A/E`, `Ctrl+U/K`, `Ctrl+W`, Option/Alt word movement, and Option/Alt delete. Some terminals let users remap Option-key behavior; if a shortcut inserts characters instead of editing text, check the terminal keyboard profile.

In `setupr chat`, Enter sends a normal message. Ctrl+Enter sends a steering instruction where supported; `/steer ...` is the portable fallback. While the AI is thinking or running, the normal chat box is locked. Press Esc to pause the AI state and Ctrl+R to resume the session.

### AI features not working

**Cause**: Missing API key.

**Fix**: Save at least one AI provider key in global Setupr auth storage:

```bash
setupr auth login
# Or: setupr auth set-key github
```

You can test provider connectivity and select a specific model with:

```bash
setupr auth test
setupr auth use kimi-k2-turbo-preview
```

Setupr works without AI — it falls back to pattern matching and heuristics.

### Error codes

Setupr errors include a stable code, explanation, details, and next steps. Useful examples:

| Code | Meaning |
|------|---------|
| `ENV_TEMPLATE_MISSING` | `.env.example` is missing, so Setupr cannot infer app env variables |
| `ENV_CHECK_FAILED` | required env values are missing, empty, or invalid |
| `AUTH_STORAGE_INVALID` | `~/.setupr/secrets.json` is corrupt or not valid JSON |
| `AUTH_STORAGE_FAILED` | Setupr could not read or write global auth storage |
| `AI_PROVIDER_AUTH_FAILED` | provider rejected the API key |
| `AI_PROVIDER_QUOTA_EXHAUSTED` | provider reported no remaining credits/quota |
| `COMMAND_NOT_FOUND` | a required command is not available on PATH |
| `INSTALL_FAILED`, `BUILD_FAILED`, `TEST_FAILED` | project command failed in that phase |
| `CLEAN_TARGET_FAILED` | a clean target could not be removed |

If `AUTH_STORAGE_INVALID` appears, Setupr stops rather than treating all keys as missing. Fix the JSON file or move it aside:

```bash
mv ~/.setupr/secrets.json ~/.setupr/secrets.json.broken
setupr auth login
```

Raw API keys and token-like values are masked in error output and AI context.

### "Permission denied" on install

**Cause**: Global npm install requires elevated permissions.

**Fix**: Use npx instead:
```bash
npx @evan-coder/setupr
```

Or fix npm permissions: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally

### Setup fails at "Install dependencies"

**Cause**: Package manager not installed or network issues.

**Fix**:
1. Verify your package manager is installed: `npm --version` / `yarn --version`
2. Check network connectivity
3. Try running the install command manually

In `--plain` mode, setup stops after the failed step and exits non-zero. Fix the failing command, then rerun `setupr --plain`.

### Test command cannot find a suite

`setupr test run` uses detected package scripts first, then language defaults such as `python -m pytest`, `cargo test`, or `go test ./...`. If no reliable command exists:

```bash
setupr test doctor
setupr test list
```

Add a native test script to the project or use `setupr test create <file> --yes` to create a starter test for one source file. Test run history is stored in `.setupr/test-runs.json`.

### Security scan reports too many known findings

Use a baseline for known existing findings and ignore individual false positives:

```bash
setupr security baseline
setupr security ignore <finding-id>
setupr security report
```

`setupr security headers` checks localhost URLs by default. For external URLs, pass `--force` so the network target is explicit:

```bash
setupr security headers --url https://example.com --force
```

### Managed process shows crashed after stop

`setupr stop` marks the supervisor entry as stopped. If a process still appears crashed, it usually means the child process ignored the stop signal or the registry was written by an older Setupr version.

```bash
setupr ps
setupr logs <target>
setupr stop <target> --force
```

Managed process state lives in `.setupr/processes.json`; logs live in `.setupr/logs/processes/`.

### Plugin validation fails

Run validation from the plugin folder or pass the plugin path:

```bash
setupr plugin validate ./setupr-plugin-my-tools
```

Useful checks:

- `package.json` has `name`, `version`, `main` or `exports`
- the name or keywords include `setupr-plugin`
- `package.json` contains a `setupr` block with `apiVersion: "1"`
- the built entrypoint exists after `npm run build`, or `src/index.ts` exists during development

### `.env` was not created

`env sync` preserves the existing file and appends missing template keys. It does not reorganize
the file or replace deliberate empty values with template defaults. If the editor reports that
values changed on disk, reload before saving so another editor's changes are preserved.

Setupr creates `.env` from `.env.example` when a template is present. If `.env` already exists, `setupr env init` leaves it unchanged unless you pass:

```bash
setupr env init --force
```

Bare `setupr env` opens the editor TUI. If `.env` is missing and `.env.example` exists, Setupr asks before creating `.env` from the template. If no template exists, it returns `ENV_TEMPLATE_MISSING`; use `setupr env --force` only when you intentionally want an empty `.env`.

### Port conflicts

Use the port command to check:
```bash
setupr port 3000
setupr port  # Check all common ports
```

### Checkpoint issues

If a checkpoint is corrupted or stale:
```bash
rm -rf .setupr/checkpoint.json
rm -rf .setupr/agent-workflow.json
setupr  # Start fresh
```

### AI re-planning did not happen

Setupr uses deterministic recovery first. Known failures such as npm peer-dependency conflicts can re-plan without a live AI call. Novel failures need a configured provider:

```bash
setupr auth doctor
setupr auth test
```

If the provider times out, Setupr reports `AI_PROVIDER_TIMEOUT` and continues with the safest heuristic behavior.

### Plugin extension not detected

Run:

```bash
setupr plugin validate ./your-plugin
```

The manifest should include `setupr.apiVersion: "1"` and at least one extension array: `commands`, `scanners`, `planners`, `doctorChecks`, `fixers`, or `panels`.

Runtime loading also requires the plugin to be enabled in Setupr config and to expose a built JavaScript entrypoint through `main`, `exports`, `dist/index.js`, or `index.js`. Run `setupr plugin doctor` to see enabled plugins and load diagnostics.

### Wrong language/framework detected

Override detection with a `.setupr.json` file:
```json
{
  "language": "TypeScript",
  "framework": "Next.js",
  "runtime": "node",
  "packageManager": "pnpm"
}
```

## Getting Help

- Run `setupr --help` for command reference
- Run `setupr doctor` to diagnose environment issues
- Run `npm run smoke:fixtures` from the repository before publishing or after large error/TUI/auth/env/command-execution changes
- Run `npm run smoke:chaos` for the reusable multi-project CLI matrix; see [Testing](docs/TESTING.md)
- File issues at: https://github.com/Evan1108-Coder/Setupr/issues
