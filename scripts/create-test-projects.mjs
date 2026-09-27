#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Files are deliberately generated, including broken files that formatters should not repair.
export function createTestProjects(destination) {
  const root = resolve(destination);
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root); // Refuse to overwrite any existing testing directory.
  const projects = [];
  const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
  const passingScripts = { test: "node -e \"console.log('fixture tests passed')\"", build: "node -e \"console.log('fixture build passed')\"", lint: "node -e \"console.log('fixture lint passed')\"" };
  function project(name, purpose, files = {}) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      const target = join(path, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    projects.push({ name, purpose });
    return path;
  }
  function git(path, ...args) {
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
      cwd: path, encoding: "utf8", timeout: 10000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    });
    if (result.status !== 0) throw new Error(`Fixture git ${args[0]} failed: ${result.stderr || result.error}`);
  }
  function repository(path) {
    git(path, "init", "-b", "main");
    git(path, "config", "user.name", "Setupr Fixture");
    git(path, "config", "user.email", "fixture@example.invalid");
    git(path, "add", ".");
    git(path, "commit", "-m", "Initial test fixture");
  }

  project("empty", "No detectable project, no fabricated health data.");
  project("healthy-node", "Small runnable Node project; test/build/lint and help workflows.", {
    "package.json": json({ name: "healthy-node", version: "1.0.0", private: true, scripts: passingScripts }),
    ".env.example": "PORT=3000\nNODE_ENV=development\n", "README.md": "Run npm test or npm run build. No external dependencies.\n",
  });
  for (const [name, dependencies, scripts] of [
    ["next-app", { next: "^14.0.0", react: "^18.0.0" }, { dev: "next dev", build: "next build" }],
    ["vite-app", { vite: "^5.0.0", react: "^18.0.0" }, { dev: "vite", build: "vite build" }],
  ]) {
    project(name, "Stack detection and missing dependencies; no install is performed.", {
      "package.json": json({ name, private: true, dependencies, scripts }), "src/index.ts": "export const ready = true;\n", ".env.example": "PORT=3000\n",
    });
  }
  project("django-app", "Python/Django detection, missing credentials and runtime.", {
    "requirements.txt": "django==5.0\npsycopg==3.1.0\n", "manage.py": "print('fixture only')\n", ".python-version": "3.11", ".env.example": "DATABASE_URL=\nSECRET_KEY=\n",
  });
  project("fastapi-app", "Python/FastAPI detection without a requirements file.", {
    "pyproject.toml": "[project]\nname = 'fastapi-fixture'\nversion = '0.0.0'\nrequires-python = '>=3.11'\ndependencies = ['fastapi', 'uvicorn']\n",
    "main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
  });
  project("rust-app", "Cargo detection and dependency counts.", {
    "Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nserde = "1"\n', "src/main.rs": 'fn main() { println!("fixture"); }\n',
  });
  project("go-app", "Go module and runtime detection.", {
    "go.mod": "module example.invalid/fixture\n\ngo 1.22\n", "main.go": "package main\nfunc main() {}\n",
  });
  project("docker-heavy", "Container/service metadata and defensive security findings.", {
    "package.json": json({ name: "docker-heavy", scripts: passingScripts }), "Dockerfile": "FROM node:22\nWORKDIR /app\nCOPY . .\nCMD [\"node\", \"server.cjs\"]\n",
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  redis:\n    image: redis:7\n", ".env.example": "DATABASE_URL=\nREDIS_URL=redis://localhost:6379\n",
  });
  const workspaces = {
    "packages/api/package.json": json({ name: "@fixture/api", version: "1.0.0", scripts: passingScripts }),
    "packages/api/src/index.js": "export const api = true;\n",
    "packages/ui/package.json": json({ name: "@fixture/ui", version: "1.0.0", scripts: passingScripts }),
    "packages/ui/src/index.js": "export const ui = true;\n",
    "packages/excluded/package.json": "{intentionally broken and excluded",
  };
  project("npm-monorepo", "Overlapping globs, scoped packages, explicit exclusions and filtered runs.", {
    "package.json": json({ name: "fixture-workspace", private: true, workspaces: ["packages/*", "packages/api", "!packages/excluded"] }), ...workspaces,
  });
  project("pnpm-monorepo", "Inline YAML arrays/comments and exclusions; inspect without installing pnpm.", {
    "package.json": json({ name: "pnpm-workspace", private: true, packageManager: "pnpm@9.0.0" }),
    "pnpm-workspace.yaml": "packages: ['packages/*', '!packages/excluded'] # skip broken package\n", ...workspaces,
  });
  for (const [name, remotes] of [
    ["git-multiple", { origin: "git@github.com:fixture-user/fork.project.git", upstream: "https://github.com/fixture-team/original.project.git", backup: "https://gitlab.com/fixture-team/mirror.git" }],
    ["git-upstream-only", { upstream: "ssh://git@github.com/fixture-team/original.project.git" }],
    ["git-mixed-hosts", { origin: "https://gitlab.com/fixture-team/mirror.git", upstream: "https://github.com/fixture-team/original.project.git" }],
  ]) {
    const path = project(name, "Local Git repository with example remote URLs. No network fetch/push occurs.", { "package.json": json({ name, scripts: passingScripts }), "README.md": "Git fixture. All remote URLs are illustrative.\n" });
    repository(path);
    for (const [remote, url] of Object.entries(remotes)) git(path, "remote", "add", remote, url);
  }
  project("malformed-package", "Invalid JSON must produce a structured nonzero error.", { "package.json": "{ broken JSON\n" });
  project("invalid-package-shape", "Valid JSON with invalid scripts/dependencies types.", { "package.json": json({ scripts: { test: 42 }, dependencies: ["react"] }) });
  project("invalid-config", "Unsupported project config types must not crash the renderer.", { "package.json": "{}", ".setupr.json": json({ runtime: { name: [] } }) });
  project("bad-workspace-yaml", "Malformed workspace YAML must not silently hide the monorepo.", { "package.json": "{}", "pnpm-workspace.yaml": "packages: [unclosed\n" });
  project("broken-lock", "Readable manifest with a corrupted lock file.", { "package.json": json({ name: "broken-lock", scripts: passingScripts }), "package-lock.json": "{broken" });
  project("many-problems", "Failing tests/build, missing dev command, invalid env, root container and bad lock.", {
    "package.json": json({ name: "many-problems", scripts: { test: "node -e \"process.exit(2)\"", build: "node missing.cjs", dev: "node missing-server.cjs" }, dependencies: { express: "^4.18.0" } }),
    "package-lock.json": "{broken", ".env.example": "DATABASE_URL=\nPORT=3000\nAPI_KEY=\n", ".env": "PORT=99999\nDATABASE_URL=\nAPI_KEY=\n", "Dockerfile": "FROM node:latest\nCOPY . .\n",
  });
  project("env-preservation", "Quoted #, spaces, CRLF, multiline values, extra variables and deliberate blanks.", {
    ".env.example": "TITLE=default\nEMPTY=example\nPRIVATE_KEY=\nNEW_SETTING=enabled\n",
    ".env": '# keep this comment\r\nTITLE="literal # text"\r\nEMPTY=\r\nPRIVATE_KEY="line one\r\nline two"\r\nEXTRA=keep\r\n',
  });
  project("env-without-template", "Missing template: fail normally, create empty env only with explicit force.", { "package.json": "{}" });
  project("corrupt-state", "Malformed/truncated local history, state and notes should fail clearly or degrade safely.", {
    "package.json": json({ name: "corrupt-state", scripts: passingScripts }), ".setupr/state.json": "{broken", ".setupr/notes.json": "{broken",
    ".setupr/history.jsonl": '{"type":"command.finish","timestamp":1,"message":"a completed fixture task"}\n{truncated\nnull\n42\n',
  });
  project("process-stable", "Actual Node process for start, ps, logs, restart, stop. Binds only loopback.", {
    "package.json": json({ name: "process-stable", scripts: { dev: "node server.cjs" } }),
    "server.cjs": "const http = require('http'); const server = http.createServer((req,res) => res.end('fixture ok')); server.listen(0, '127.0.0.1', () => console.log('fixture listening ' + server.address().port)); process.on('SIGTERM', () => server.close(() => process.exit(0)));\n",
  });
  project("process-crash", "Immediate nonzero startup failure and process registry state.", {
    "package.json": json({ name: "process-crash", scripts: { dev: "node crash.cjs" } }), "crash.cjs": "console.error('fixture deliberate crash'); process.exit(3);\n",
  });
  project("project with spaces", "Spaces in project paths, long metadata and long env values for terminal layout.", {
    "package.json": json({ name: "long-" + "project-name-".repeat(18), scripts: passingScripts }), ".env.example": "LONG_VALUE=" + "x".repeat(1500) + "\nPORT=3000\n",
  });
  writeFileSync(join(root, "fixtures.json"), json({ version: 1, projects }));
  writeFileSync(join(root, "README.md"), `# Setupr Testing Projects\n\nGenerated fixtures, not production applications. No real credentials are included.\nGit remotes are local configuration only and point to illustrative repositories.\nThe Next/Vite/Python/Rust/Go fixtures test inspection, not third-party dependency installation.\n\n${projects.map((p) => `- **${p.name}**: ${p.purpose}`).join("\n")}\n\nTry: setupr status --plain --cwd "${join(root, "healthy-node")}"\n\nRun the automated matrix from the Setupr repository:\n\n\`\`\`sh\nnode scripts/smoke-chaos.mjs --fixtures "${root}"\n\`\`\`\n`);
  return root;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = process.argv[2];
  if (!destination) { console.error("Usage: node scripts/create-test-projects.mjs <new-directory>"); process.exitCode = 1; }
  else {
    try { console.log(`Created testing projects: ${createTestProjects(destination)}`); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
