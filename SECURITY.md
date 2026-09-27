# Security Policy

## Supported Versions

Security fixes are handled on the default branch unless a release branch is explicitly listed.

## Reporting a Vulnerability

Please do not open a public issue for a suspected vulnerability. Email the maintainer or use GitHub's private vulnerability reporting when available. Include:

- Affected version or commit
- Steps to reproduce
- Impact and likelihood
- Any relevant logs with secrets removed

## Secret Handling

Never commit API keys, Telegram tokens, OAuth credentials, database files, `.env` files, or local user exports. Use `.env.example` for placeholders only.

Secrets are redacted on a best-effort basis (`redactText`/`redactObject` in `src/core/engine.ts`) before commands, history, and logs are persisted. This targets common token shapes and `NAME=value` credential assignments — it is not a guarantee that no secret will ever reach a log file.

Use `setupr secrets set NAME` without an inline value for hidden input. Inline values may
remain in shell history or process arguments outside Setupr's control. `secrets get` and
`secrets export` intentionally reveal plaintext; treat their output and destination files
as sensitive. The encrypted store and its local key must not be shared together. Back up
both before rotation, which is not an atomic two-file transaction.

## Threat Model

Setupr runs real shell commands on your machine with your full user privileges. The command-safety
layer (`src/agent/safety.ts`) is a **best-effort, defense-in-depth guard, not a sandbox.** It
classifies each planned command and decides whether to allow, confirm, or block it:

- **Block (cannot be bypassed by `--force`)** — clearly destructive or hostile patterns such as
  `rm -rf /` (and `~`, `*`, `$HOME` variants), `sudo`, `chmod 777`, `chown -R`, and
  `curl … | sh`/`| bash` pipe-to-shell installs.
- **Confirm** — high/medium-risk commands (dependency installs, commands that delete files or reset
  git state, commands that embed a secret value or `KEY=value` credential assignment). `--force`
  may proceed past a **medium**-risk confirmation using safe defaults, but **never** past a
  high-risk or blocked one.
- **Allow** — everything else.

What this layer is **not**:

- **Not a security boundary.** Anything you could run in your shell, a command run through Setupr
  can run.
- **The block list is a denylist, and denylists are inherently incomplete.** It catches common,
  obvious footguns; an obfuscated or equivalent destructive command can get past it. Treat the
  guard as a seatbelt, not a vault door.
- **Trust the project and its AI-generated plan.** When AI planning is enabled, setup steps may be
  proposed by a model based on the project's contents. Review the plan — especially before using
  `--force` — the way you would review a shell script you downloaded.

Recommendations: run Setupr only against projects you trust, read the pre-execution plan before
confirming, be deliberate with `--force`, and keep real secrets in `.env` files rather than inline
in commands.
