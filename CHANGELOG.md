# Changelog

All notable changes to Setupr will be documented in this file. Setupr keeps a changelog because it is a versioned developer tool with user-facing CLI behavior.

## 1.0.6

### Fixed
- Validate manifest/config structure before scanning; parse workspace YAML, honor exclusions, deduplicate packages, and reject paths/symlinks outside the project.
- Protect workspace creation from traversal and overwrites, quote script names, use the root package manager, and propagate failed or unmatched workspace operations.
- Support multiple Git remotes with explicit selection; redact URL credentials, honor tracking/push configuration, and stop sync after failed pulls.
- Preserve env comments, extra keys, blank values, quoted and multiline content. Use atomic saves with conflict detection and safe serialization.
- Mask sensitive env diagnostics and prevent readline history/editing buffers from revealing earlier secret answers. Unresolved env fixes no longer report success.
- Refresh Git, env, and file-tree context while retaining documentation caching; invalidate cached context when setup notes change.
- Redact arbitrary credential fields and positional secret values from local command history.
- Hide project-secret prompts and list values; preserve quoted/multiline import/export data, validate decrypted payloads, and reject unsafe export destinations.
- Detect ordinary Python pyproject metadata and use `pip install .` for pyproject-only projects instead of a missing requirements file.
- Harden terminal input against split mouse/paste/control sequences, Unicode editing errors, focus changes, and resize overflow.
- Confirm managed-process startup before reporting success, retain early crash exit codes/logs, and stop the supervised child process tree during shutdown.
- Preserve automatic and case-sensitive script targets across managed-process restarts.
- Count all managed processes, recognize dependency-free manifests, and show unavailable health/security measurements as `N/A` instead of invented scores. JSON score/finding fields are `null` when unmeasured.

### Added
- `--remote <name>` for GitHub targets, Git PR/sync operations, and opening repositories; `--filter <package>` for workspace run/exec.
- A reusable generator for 26 realistic/broken testing folders and a CLI matrix checking exits, structured output, file preservation, and process lifecycle behavior.
- Fresh builds before packing/publishing, wider CI coverage, and testing documentation explaining what is and is not verified.

### Maintenance
- Updated vulnerable dependency versions and pinned the build toolchain to a patched esbuild release. No known npm audit advisories remain at validation time.

## 1.0.5

### Changed
- Improved the npm package presentation with a sharper package description, stronger search keywords, and a README opening focused on the main user problem: cloning an unfamiliar project and needing to know what it is, what is missing, and what to do next.
- Added clearer "safe first run", "what Setupr checks", "what Setupr will not do without asking", and "why not just read the README" sections so npm visitors can understand the tool before installing it.
- Moved the first-screen README emphasis from the full feature surface to the practical first commands: `setupr`, `setupr doctor`, `setupr env`, `setupr status`, and `setupr test quick`.

### Validation
- Prepared as a docs/metadata patch release for npm page polish.

## 1.0.4

### Changed
- Promoted the public README from beta language to stable-release language now that the npm package, install flow, and release checks are in place.
- Hardened repository ignore rules for additional local secret and credential file patterns that should never be committed during real-world CLI use.

### Validation
- Re-ran the full release gate: unit tests, typecheck, lint, build, plain and TUI smoke fixtures, `release check`, npm pack/publish dry-runs, and fresh-install execution from the packed tarball.

## 1.0.3

### Fixed
- Merged the latest GitHub `1.0.2` release line with the local TUI hardening work.
- Added terminal-size protection for TUI screens so very small terminals show a resize notice instead of breaking panel borders.
- Added configurable TUI border fallback styles through `SETUPR_TUI_BORDER=bold`, `double`, `round`, or `classic` for terminal/font profiles that render thin Unicode borders with gaps.
- Improved AI provider error classification for structured SDK errors, including nested status/statusCode/code/response fields and clearer quota-vs-rate-limit handling.
- Hardened plugin runtime loading by supporting common package `exports` objects, rejecting entrypoints that escape the plugin directory, and wrapping plugin command crashes in structured Setupr errors.

### Testing
- Added regression coverage for structured provider errors, plugin package `exports`, plugin path escapes, plugin command failures, terminal-size fallback, and border-style fallback behavior.

## 1.0.2

### Fixed
- `--cwd <path>` now fails fast with a clear `INVALID_CWD` error when the path does not exist or is not a directory, instead of silently inventing an empty project for a bad path.
- `add`, `remove`, and `deps why` with no package argument now report a `MISSING_PACKAGE` ("package name required") error instead of a misleading "unknown subcommand".

### Testing
- Completed two full test→fix QA rounds: ran typecheck, lint, the unit suite, and both fixture smoke harnesses (plain + TUI), and exercised every command and its flags against sample projects looking for crashes, arg-parsing bugs, and error-path regressions.
- Added unit coverage for the new error codes plus two new fixture smoke checks (`INVALID_CWD`, `MISSING_PACKAGE`). Suite is green at 192 unit tests + 45 smoke checks.

### Docs
- Documented the `--json` and `--cwd` global flags in `docs/COMMANDS.md`.

## Unreleased

### Fixed
- TUI text input no longer leaks bracketed-paste markers: pasting (Cmd+V) into the chat or `.env` editor previously inserted literal `[200~`/`[201~` around the pasted text. The input sanitizer only stripped these guards when they still carried their leading escape byte, but Ink consumes that byte first, so the bare markers leaked. Both forms (and split-across-chunk partials) are now stripped, while ordinary bracket text such as `arr[200]=x` is preserved.
- The `.env` editor's "paste KEY=value lines to update several variables at once" now works: a multi-line paste previously collapsed into a single concatenated value (e.g. `API_KEY=…DATABASE_URL=…PORT=…`) because terminals deliver pasted line breaks as carriage returns, which were dropped as control characters before being converted to newlines. Carriage returns are now normalized to newlines first, so each pasted line becomes its own variable.
- The `setupr dashboard` footer advertised a `? help` shortcut that had no handler (pressing `?` did nothing) and omitted the working `q` quit shown on every other screen; the footer now correctly advertises `q quit`.
- TUI text input now deletes correctly: Backspace (and Fn+Delete) removes the character before the cursor instead of doing nothing. macOS Backspace sends `0x7f`, which Ink reports as `delete`; this was being routed to a forward delete, so it was a no-op at the end of a line. Forward delete remains available via Ctrl+D.
- TUI text input no longer drops, scrambles, or appears to insert stray spaces between characters during fast typing or pastes. The component now tracks the live value/cursor synchronously instead of reading stale state between keystrokes, so a rapid burst types exactly what was entered, in order. This also fixes the input/border "squish" where overflowing garbled text broke the panel layout.
- `setupr port <value>` now validates its argument and rejects non-numeric or out-of-range ports (must be an integer 1–65535) instead of reporting them as "available"; this also removes a raw-string interpolation into the underlying `lsof`/`netstat` command.
- Error messages now show the directory the command actually targeted (e.g. via `--cwd`) instead of Setupr's own working directory; the top-level handler's fallback context no longer overwrites accurate, command-specific error fields.
- `setupr registry` with no subcommand now prints a clear usage hint, and a valid registry with no package name reports "package name required" instead of a misleading "unknown subcommand".

### Added
- Added regression coverage for the TUI input fixes (backspace/delete semantics, rapid-burst integrity, unicode/emoji, large paste, control-character/ANSI stripping, masked values) and for TUI border/rendering integrity at multiple terminal widths, using a faithful Ink keypress/render harness.
- Added regression coverage for real-terminal paste handling: bare (escape-stripped) bracketed-paste markers, split-chunk paste partials, preservation of ordinary bracket text, and carriage-return multi-line pastes splitting into distinct `.env` variables end-to-end.
- Added real repository visual snapshot assets generated from the current file tree.
- Added public maintenance documentation updates: security policy, issue/PR templates, and repository snapshot notes.
- Added Mermaid diagrams to the README (run lifecycle, detection priority, 3-tier intelligence, safety gate) and to `docs/FEATURES.md` (provider key/model resolution order) so the previously text-only sections are visual.
- Added an end-to-end "worked example" walkthrough to the README showing a real `setupr setup --plain` run on a fresh Next.js clone.

### Changed
- Renamed the AI model override environment variable to `SETUPR_AI_MODEL` (and documented `SETUPR_LOG_LEVEL`) to match the Setupr name. The legacy `P_SETUP_AI_MODEL` is still accepted as a backward-compatible alias; when both are set, `SETUPR_AI_MODEL` wins.
- Replaced remaining internal `p-setup`/`P_SETUP` naming leftovers in source identifiers, ignore rules, and `.env.example` with `setupr`/`SETUPR` equivalents. No CLI command, flag, or public behavior changed.

### Testing
- Added regression coverage proving the legacy `P_SETUP_AI_MODEL` alias still resolves and that `SETUPR_AI_MODEL` takes precedence when both are set.

### Validation
- Re-ran the documented test suite during the polish pass and recorded the real test status in `docs/project-snapshot.md`.

## Initial Public Version

- Published the first public project version.
