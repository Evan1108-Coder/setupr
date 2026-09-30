# Release Verification Snapshot

This is a historical snapshot of the 1.0.6 hardening pass on 2026-09-27. For current release changes, see [CHANGELOG.md](../CHANGELOG.md).
It is a verification record, not a guarantee that every project or terminal works.

## What Changed

- Added 26 reusable fixtures covering multiple Git remotes, npm/pnpm monorepos,
  framework metadata, broken manifests/configuration, corrupted local state,
  environment edge cases, process failures, and paths containing spaces.
- Hardened workspace discovery and creation, explicit remote selection, environment
  preservation, sensitive input/history, context freshness, and terminal input.
- Added process startup acknowledgement and lifecycle regression tests.
- Updated dependencies and added a fresh build to the npm packaging lifecycle.

## Verification

Local results on macOS, 2026-09-27:

| Check | Result |
| --- | --- |
| Unit/component/integration suite | 601 tests passed in 43 files |
| Built CLI chaos matrix | 116 checks passed |
| Existing fixture + PTY suite | 47 checks passed, including a saved env edit |
| Typecheck, lint, build | Passed |
| npm dependency audit | Zero known advisories in the installed dependency tree |
| Fresh tarball install | Both executable names resolve; Node 18 version/status checks pass |

The repository audit flags the presence of a local `.env`; it is ignored by Git,
untracked, and excluded from the npm package. Its contents are not test input.

Run the commands in [Testing Setupr](TESTING.md) to reproduce the checks. The CLI
matrix checks exit codes, parsed output, file effects, and actual supervised
processes. The PTY smoke suite also enters an environment value and verifies the
saved file, rather than treating a launch banner as proof that editing works.

The release artifact is installed outside the source checkout before publishing.
Both `setupr` and the compatibility alias `setup` must resolve from that install.
Production package contents are checked for build output and documentation only;
local state, credentials, test folders, and dependency directories are excluded.

## Boundaries

- Framework fixtures do not install every framework or provision databases.
- Tests use synthetic secrets and do not exhaust live model quotas.
- Multiple-remotes tests inspect local Git configuration and local transport;
  they do not create GitHub repositories or perform authenticated remote pushes.
- Ink/component and pseudo-terminal checks are not native iTerm2/Ghostty screenshots.
- A supervised process surviving the initial startup check is not proof that its
  HTTP endpoint is ready or that it will never crash later.
- Registry publication is separate from successful local packaging and installation.

## Maintenance

CI runs typechecking, linting, unit/integration tests, the CLI fixture matrix,
package dry-runs, and production dependency audits. Keep [CHANGELOG.md](../CHANGELOG.md),
[COMMANDS.md](COMMANDS.md), and the fixture expectations in sync with behavior changes.
