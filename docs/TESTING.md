# Testing Setupr

## Reusable Projects

Create a new directory containing 26 independent scenarios:

```sh
npm run fixtures:create -- ../Setupr-Testing/my-new-run
setupr status --plain --cwd ../Setupr-Testing/my-new-run/healthy-node
setupr github status --remote upstream --cwd ../Setupr-Testing/my-new-run/git-multiple
setupr workspace list --cwd ../Setupr-Testing/my-new-run/pnpm-monorepo
```

The generator refuses to overwrite an existing directory. Each generated collection has a README
and `fixtures.json` describing its purpose. All credentials are synthetic. Git remotes are local
configuration with illustrative URLs; generating the projects does not contact GitHub or create
remote repositories.

| Area | Scenarios |
| --- | --- |
| Stacks | Small runnable Node project; Next.js, Vite, Django, FastAPI, Rust, Go, Docker metadata |
| Workspaces | npm and pnpm, overlapping globs, excluded broken package, scoped package names |
| Git | Fork + upstream + backup; upstream only; GitLab origin + GitHub upstream |
| Broken inputs | Invalid JSON, wrong manifest types, invalid config, malformed YAML, bad lockfile |
| Env | Missing template; quotes, CRLF, multiline content, comments, extra keys, intentional blanks |
| State | Truncated history, malformed state and notes |
| Processes | A real loopback Node server, intentional crash, combined broken-project failures |
| Layout/path | Very long values and metadata; project directory containing spaces |

These are focused fixtures. The framework examples are not complete applications, and the smoke
matrix does not install every framework's dependencies or provision databases/cloud services.

## Automated Checks

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run smoke:chaos
npm run smoke:fixtures:tui
npm audit
npm pack --dry-run
```

The chaos matrix runs the built executable as child processes. It checks exits, JSON, file effects,
51 command help pages, environment handling, workspace operations, Git selection, test/build
failures, plugin scaffolding/validation, and actual process start/log/restart/stop/crash behavior.
Test servers bind only loopback and are stopped in cleanup. Child processes use an isolated home
and no inherited provider credentials. The user's auth, preferences, and projects are not test data.

```sh
node scripts/smoke-chaos.mjs --fixtures ../Setupr-Testing/my-new-run --keep
```

This copies the collection into a temporary directory before running, so manual fixtures remain
unchanged. `--keep` preserves the working projects and JSON report. Failed runs retain their report
automatically. Without `--fixtures`, the matrix generates a fresh temporary collection itself.
Set `SETUPR_TEST_CLI` to the absolute path of an installed package's `dist/setup.js` to test that artifact.

The older `smoke:fixtures:tui` harness requires `expect` and verifies actual PTY startup and an env
edit saved to disk. Unit/component tests separately cover resize, mouse and paste sequences,
focus, keyboard shortcuts, secret masking, Unicode input, and panel bounds.

## Limits

Passing these checks is evidence for the recorded cases, not a claim that every possible project
or terminal has been tested. Live provider quotas/model availability, authenticated Git transport,
and native iTerm2/Ghostty rendering need separate checks in those environments. An automated
Ink frame or PTY capture is not a screenshot from those native applications.

The terminal background continues to come from the terminal profile. Input values are preserved
as entered. For complex combining/ZWJ clusters that Ink 5 cannot render within correct column
bounds, the input uses a display-only Unicode escape representation; submission retains the
original text. Ordinary supported Unicode remains visible normally, and masked values stay masked.

## Packaging

`npm pack` and `npm publish` trigger `prepack`, rebuilding the CLI. CI exercises Linux with Node
20/22/24 and macOS with Node 22. The published CLI targets Node 18; the development toolchain
requires Node 20.19+ or a supported newer Node release.

The esbuild override keeps the build/test toolchain on the patched 0.28 line while tsup's upstream
dependency range still targets 0.27. Revalidate build, tests, packaging, and `npm audit` when changing it.
