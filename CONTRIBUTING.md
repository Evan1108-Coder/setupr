# Contributing to Setupr

## Development

```bash
git clone https://github.com/Evan1108-Coder/Setupr.git
cd Setupr
npm install
npm run dev  # Watch mode
```

## Architecture

```
src/
├── cli/          # CLI entry, routing, pre-warning, transition
├── commands/     # Non-TUI command implementations
├── tui/          # React/Ink TUI components and layouts
├── scanner/      # Project detection (language, framework, PM, services)
├── ai/           # Multi-provider AI client (6 providers), intelligence layers, DSL
├── agent/        # AI director runtime: safety, plan diffs, checkpoints, provider diagnostics
├── executor/     # Step execution, checkpoint saving, undo/redo
├── processes/    # Managed process supervisor, registry, and logs
├── status/       # Dashboard/status collection
├── verification/ # Test, smoke, CI, report, and scaffold verification workflows
├── security/     # Defensive local security scans, reports, baselines, and ignores
├── context/      # Environment context collection
├── plugins/      # Public plugin API contracts
├── state/        # Zustand store, checkpoint, config
└── utils/        # Shared utilities
```

## Adding a New Language

1. Add detection signals to `src/scanner/languageDetector.ts`
2. Add install command mapping in `src/ai/planner.ts`
3. Test with a sample project

## Adding a New Framework

1. Add framework signals to `src/scanner/frameworkDetector.ts`
2. Test detection with a real project

## Adding a New Command

### Non-TUI Command
1. Add handler in `src/commands/plain/router.ts`
2. Add the command to `src/cli/commandRegistry.ts`
3. Add focused tests under `tests/`

### TUI Command
1. Create layout in `src/tui/layouts/`
2. Add case in `src/tui/App.tsx`
3. Add the command to `src/cli/commandRegistry.ts`
4. Verify alternate screen, resize behavior, mouse/click input, and bounded text rendering

## Building Plugins

Use Setupr's plugin developer commands instead of hand-writing boilerplate:

```bash
setupr plugin create my-tools
cd setupr-plugin-my-tools
npm install
npm run build
setupr plugin validate .
```

Plugin packages should include:

- a package name or keyword containing `setupr-plugin`
- a `setupr` block in `package.json` with `apiVersion: "1"`
- a built entrypoint exposed through `main` or `exports`
- deterministic failure behavior: invalid manifests should surface `PLUGIN_INVALID`, install/load failures should surface `PLUGIN_LOAD_FAILED`
- extension points should return structured values and route shell work through the executor/safety layer
- runtime plugins should be enabled through Setupr config; setup planners, doctor checks, panels, and commands receive a `SetuprPluginContext` with scan and project context

## Testing

```bash
npm test          # Run tests
npm run typecheck # Type check
npm run lint      # Lint source
npm run build     # Build the npm package entrypoint
npm run smoke:fixtures # Exercise representative CLI fixtures
npm run smoke:fixtures:tui # Include real pseudo-terminal doctor/env interactions (requires expect)
npm run smoke:chaos # Run the real CLI across deliberately healthy and broken projects
npm run smoke:package # Install and run the packed package in a clean temporary directory
npm run fixtures:create -- ../Setupr-Testing/my-new-run # Keep reusable projects for manual testing
```

See [Testing](docs/TESTING.md) for the fixture matrix, isolation rules, and verification limits.
`npm pack` runs a fresh build through `prepack`; never publish an unverified or stale `dist/`.

## Releasing to npm

Setupr publishes `@evan-coder/setupr` from `.github/workflows/release.yml` using npm Trusted Publishing, not a long-lived access token. Before the first workflow release, the npm package owner must add a GitHub Actions trusted publisher for owner `Evan1108-Coder`, repository `setupr`, and workflow file `release.yml` in the package's npm settings. The npm repository name should match the spelling shown in GitHub's repository settings.

1. Merge the intended source and version into `master`, then wait for CI to pass. The package version must be new on npm.
2. Run `npm run typecheck`, `npm run lint`, `npm test`, and `npm run smoke:package` locally. Review `npm publish --dry-run` and the changelog.
3. Create and publish a GitHub Release from that tested commit with tag `v<package.json version>` (for example `v2.0.1`). Publishing the release runs the workflow, which repeats the gates and publishes to npm with provenance.
4. Check the workflow result, then verify `npm view @evan-coder/setupr version` and run `npx --yes @evan-coder/setupr@<version> --version` from outside this repository.

Do not publish a GitHub Release before the trusted publisher is configured; the release workflow will fail authentication. Do not paste npm tokens into chat, source control, or workflow files.

## Code Style

- TypeScript strict mode
- ESM modules
- Functional components for TUI (React/Ink)
- No unnecessary comments — code should be self-documenting

## Pull Requests

1. Create a feature branch
2. Make your changes
3. Ensure `npm run typecheck` passes
4. Ensure `npm test` passes
5. Submit PR with description of changes
