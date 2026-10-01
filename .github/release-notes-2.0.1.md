# Setupr 2.0.1: A project-control terminal

Setupr brings project setup and day-to-day checks into one CLI. This release keeps the `@evan-coder/setupr` package and `setupr` command, with no intentional breaking CLI change.

## What changed

- **Project overview:** The dashboard and status views bring detected stack, Git state, environment health, dependencies, managed processes, and recent activity together.
- **Guided workflows:** Setup, doctor, start, test, and security use project-aware checks and actionable errors. Plain output remains available for scripts and CI.
- **Optional AI assistance:** Project chat now formats Markdown replies, shows pending and retry progress, supports cancellation, and keeps long input and transcripts inside their panels. Supported plain commands can use `--explain` for a separate AI explanation after the normal result. Setupr's non-AI checks remain usable without a provider key.
- **Environment and repository handling:** The release includes env editing, monorepo and multiple-Git-remote handling, and managed-process controls.
- **Terminal and release fixes:** Input editing, paste handling, resize behavior, and bundled version display were hardened. Update hints now point to the owned scoped npm package.

## Verification

Before release, the source passed typecheck, lint, unit tests, fixture and terminal smoke checks, and an install-and-run check of the packed package, including Node 18. The release workflow repeats its own gates before publishing. Real terminal behavior can still depend on terminal, font, and color profile; use `--plain` where a TUI is unavailable.

Install or update with `npm install -g @evan-coder/setupr`, then run `setupr` inside a project. See the [README](https://github.com/Evan1108-Coder/setupr#readme) and [changelog](https://github.com/Evan1108-Coder/setupr/blob/master/CHANGELOG.md) for commands and detailed changes.
