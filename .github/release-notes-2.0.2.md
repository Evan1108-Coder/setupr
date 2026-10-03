# Setupr 2.0.2

This maintenance release fixes unsafe `--dry-run` behavior, chat routing and error statuses, and dense TUI layouts in small terminals. It does not change the package name or primary `setupr` command.

- Unsupported `--dry-run` now fails before setup, clean, or other Setupr commands can act. Use documented preview/check commands where available; do not assume a command has a dry-run mode.
- Questions that mention a constraint such as "without running it" remain questions, not plan changes.
- One-shot chat now exits unsuccessfully when AI is unavailable; the TUI shows the failure and remains available for another message.
- Missing requested logs return an unsuccessful exit status.
- Terminals below 60x24 show a resize notice rather than cramped, overlapping panels.

Install or update after this release is published with `npm install -g @evan-coder/setupr`. See the [changelog](https://github.com/Evan1108-Coder/Setupr/blob/master/CHANGELOG.md) for details.
