#!/usr/bin/env node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "dist", "setup.js");
const keep = process.argv.includes("--keep");
const includeTui = process.argv.includes("--tui");
const temp = mkdtempSync(join(tmpdir(), "setupr-smoke-"));
const results = [];
const errorCases = new Set([
  "malformed package", "malformed setupr config", "missing env template", "bare env missing template",
  "bare env missing file", "bad env smart", "corrupt auth storage", "missing build script", "failing test script",
  "invalid --cwd rejected", "missing package arg", "non-numeric port rejected",
  "out-of-range port rejected", "no project setup", "no project update", "forced non-tty tui",
  "missing remote",
]);

function main() {
  createFixtures();
  plainSmoke();
  if (includeTui) tuiSmoke();
  report();
  if (!keep && !results.some(result => !result.ok)) rmSync(temp, { recursive: true, force: true });
}

function createFixtures() {
  dir("malformed-pkg");
  dir("malformed-config");
  dir("env-missing");
  dir("env-tui-force");
  dir("env-bad");
  dir("no-project");
  dir("js-failing");
  dir("js-new");
  dir("corrupt-home/.setupr");
  dir("monorepo/packages/a");
  dir("git-safe");
  dir("tui-empty");
  dir("next-app/pages");
  dir("vite-app/src");
  dir("django-app");
  dir("fastapi-app");
  dir("rust-app/src");
  dir("go-app");
	  dir("docker-heavy");
	  dir("broken-lock");
  dir("process-lifecycle");

  write("malformed-pkg/package.json", "{\"scripts\":{\"test\":\"node -e \\\\\\\"process.exit(1)\\\\\\\"\"}");
  write("malformed-config/.setupr.json", "{broken");
  write("env-bad/.env.example", "DATABASE_URL=\nPORT=70000\nAPI_KEY=short\nEMAIL=bad\n");
  write("env-bad/.env", "DATABASE_URL=\nPORT=70000\nAPI_KEY=short\nEMAIL=bad\n");
  write("js-failing/package.json", JSON.stringify({
    scripts: {
      test: "node -e \"process.exit(1)\"",
      start: "node missing.js",
    },
    dependencies: { "left-pad": "0.0.1" },
  }));
  write("js-new/package.json", JSON.stringify({
    name: "js-new",
    scripts: {
      test: "node -e \"console.log('test ok')\"",
      lint: "node -e \"console.log('lint ok')\"",
      format: "node -e \"console.log('format ok')\"",
      "format:check": "node -e \"console.log('format check ok')\"",
    },
    dependencies: { express: "^4.18.0" },
  }));
  write("js-new/.env.example", "API_KEY=\nDATABASE_URL=\n");
  write("corrupt-home/.setupr/secrets.json", "{broken");
  write("monorepo/package.json", JSON.stringify({
    workspaces: ["packages/*"],
    scripts: { build: "node -e \"console.log(1)\"" },
  }));
  write("monorepo/packages/a/package.json", JSON.stringify({
    name: "a",
    scripts: { dev: "node -e \"setInterval(()=>{},1000)\"" },
  }));
  write("git-safe/package.json", JSON.stringify({
    name: "git-safe",
    scripts: { test: "node -e \"console.log(1)\"", lint: "node -e \"console.log(1)\"" },
  }));
  write("git-safe/file.txt", "one\n");
  spawnSync("git", ["init", "-b", "main"], { cwd: join(temp, "git-safe"), encoding: "utf8" });
  spawnSync("git", ["config", "user.email", "smoke@example.com"], { cwd: join(temp, "git-safe"), encoding: "utf8" });
  spawnSync("git", ["config", "user.name", "Smoke Test"], { cwd: join(temp, "git-safe"), encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: join(temp, "git-safe"), encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "feat: initial"], { cwd: join(temp, "git-safe"), encoding: "utf8" });

  write("next-app/package.json", JSON.stringify({
    scripts: { dev: "next dev", build: "next build", start: "next start" },
    dependencies: { next: "^14.0.0", react: "^18.0.0", "react-dom": "^18.0.0" },
  }));
  write("next-app/README.md", "## Setup\nnpm install\ncopy .env.example\nnpm run dev\n");
  write("next-app/.env.example", "DATABASE_URL=\nNEXT_PUBLIC_BASE_URL=http://localhost:3000\n");
  write("next-app/pages/index.js", "export default function Home(){return 'ok'}\n");
  write("vite-app/package.json", JSON.stringify({
    scripts: { dev: "vite --host 0.0.0.0", build: "vite build", test: "vitest" },
    dependencies: { "@vitejs/plugin-react": "^5.0.0", vite: "^5.0.0", react: "^18.0.0" },
  }));
  write("vite-app/src/main.jsx", "console.log('vite')\n");
  write("django-app/pyproject.toml", "[project]\nname='django-app'\ndependencies=['django']\n");
  write("django-app/manage.py", "print('django')\n");
  write("django-app/.env.example", "SECRET_KEY=\nDATABASE_URL=\n");
  write("fastapi-app/pyproject.toml", "[project]\nname='fastapi-app'\ndependencies=['fastapi','uvicorn']\n");
  write("fastapi-app/main.py", "from fastapi import FastAPI\napp=FastAPI()\n");
  write("rust-app/Cargo.toml", "[package]\nname='rust-app'\nversion='0.1.0'\nedition='2021'\n");
  write("rust-app/src/main.rs", "fn main(){println!(\"hi\")}\n");
  write("go-app/go.mod", "module example.com/goapp\n\ngo 1.22\n");
  write("go-app/main.go", "package main\nfunc main(){}\n");
  write("docker-heavy/package.json", JSON.stringify({
    scripts: { dev: "node server.js" },
    dependencies: { express: "^4.18.0" },
  }));
  write("docker-heavy/Dockerfile", "FROM node:20\nWORKDIR /app\n");
  write("docker-heavy/docker-compose.yml", "services:\n  db:\n    image: postgres\n  redis:\n    image: redis\n");
  write("docker-heavy/README.md", "Run docker compose up, then npm run dev.\n");
  write("broken-lock/package.json", JSON.stringify({
    scripts: { dev: "node server.js" },
    dependencies: { express: "^4.18.0" },
  }));
	  write("broken-lock/package-lock.json", "{broken");
  write("process-lifecycle/package.json", JSON.stringify({
    scripts: { dev: "node -e \"setInterval(()=>{},1000)\"" },
  }));
	}

function plainSmoke() {
  expectRun("malformed package", "malformed-pkg", ["info", "--plain"], ["MALFORMED_PROJECT_FILE", "package.json"]);
  expectRun("malformed setupr config", "malformed-config", ["info", "--plain"], ["PROJECT_CONFIG_INVALID", ".setupr.json"]);
  expectRun("missing env template", "env-missing", ["env", "init", "--plain"], ["ENV_TEMPLATE_MISSING"]);
  expectRun("bare env missing template", "env-missing", ["env", "--plain"], ["ENV_TEMPLATE_MISSING"]);
  expectRun("forced empty env", "env-missing", ["env", "init", "--plain", "--force"], ["Created empty .env"]);
  expectRun("bare env missing file", "js-new", ["env", "--plain"], ["ENV_FILE_MISSING"]);
  expectRun("bad env smart", "env-bad", ["env", "smart", "--plain"], ["ENV_SMART_FAILED", "Unresolved variables:", "No changes were saved"]);
  expectRun("corrupt auth storage", "no-project", ["auth", "status", "--plain"], ["AUTH_STORAGE_INVALID"], {
    env: { HOME: join(temp, "corrupt-home") },
  });
  expectRun("missing build script", "js-failing", ["build", "--plain"], ["MISSING_SCRIPT"]);
  expectRun("failing test script", "js-failing", ["test", "--plain"], ["Setupr Test run", "fail"]);
  expectRun("test quick", "js-new", ["test", "quick", "--plain"], ["Setupr Test quick", "pass"]);
  expectRun("test doctor", "js-new", ["test", "doctor", "--plain"], ["Setupr Test doctor", "Test script"]);
  expectRun("test report", "js-new", ["test", "report", "--plain"], ["Setupr Test doctor"]);
  expectRun("security quick", "js-new", ["security", "quick", "--plain"], ["Setupr Security scan", "Score:"]);
  expectRun("security deep report", "docker-heavy", ["security", "deep", "--plain", "--report", ".setupr/security-smoke.md"], ["Setupr Security deep", "Container may run as root"]);
  expectRun("security headers guarded", "js-new", ["security", "headers", "--plain", "--url", "https://example.com"], ["External URL requires explicit authorization", "Rerun with --force"]);
  expectRun("invalid --cwd rejected", "js-new", ["status", "--plain", "--cwd", join(temp, "does-not-exist")], ["INVALID_CWD", "Directory not found"]);
  expectRun("missing package arg", "js-new", ["add", "--plain"], ["MISSING_PACKAGE", "Package name required"]);
  expectRun("non-numeric port rejected", "js-new", ["port", "abc", "--plain"], ["INVALID_ARGUMENT", "not a valid port"]);
  expectRun("out-of-range port rejected", "js-new", ["port", "99999", "--plain"], ["INVALID_ARGUMENT", "not a valid port"]);
	  expectRun("no project setup", "no-project", ["setup", "--plain", "--force"], ["NO_PROJECT_DETECTED"]);
  expectRun("no project update", "no-project", ["update", "--plain"], ["NO_PROJECT_DETECTED"]);
  expectRun("forced non-tty tui", "js-new", ["status", "--tui"], ["TUI_RENDER_FAILED", "--tui was requested"]);
	  expectRun("monorepo info", "monorepo", ["info", "--plain"], ["Monorepo:", "npm-workspaces"]);
  expectRun("missing lock/log/repo", "env-missing", ["diff", "--plain"], ["LOCK_STATE_MISSING"]);
  expectRun("missing logs", "env-missing", ["logs", "--plain"], ["LOG_FILE_MISSING"], { expectedExitCode: 1 });
  expectRun("missing remote", "env-missing", ["open", "repo", "--plain"], ["OPEN_TARGET_MISSING"]);
  expectRun("new command ci", "js-new", ["ci", "github", "--plain"], ["Generated github CI config"]);
  expectRun("new command docker", "js-new", ["docker", "generate", "--plain", "--force"], ["Dockerfile", "Docker files generated"]);
  expectRun("new command secrets", "js-new", ["secrets", "init", "--plain", "--force"], ["Generated encryption key", "Added secrets.key to .gitignore"]);
  expectRun("new command share", "js-new", ["share", "export", "--plain"], ["Exported"]);
  expectRun("new command workspace", "monorepo", ["workspace", "list", "--plain"], ["Workspace Packages", "a"]);
  expectRun("new command scaffold nested", "js-new", ["scaffold", "test", "src/lib/math.ts", "--plain"], ["Created test: src/lib/math.test.ts"]);
  expectNoFile("git shell injection blocked", "git-safe", ["git", "branch", "create", `bad; touch ${join(temp, "git-pwned")} #`, "--plain"], join(temp, "git-pwned"));
  expectRun("agent context next app", "next-app", ["status", "--plain", "--json"], ["Next.js", "NEXT_PUBLIC_BASE_URL"]);
  expectRun("agent context vite app", "vite-app", ["status", "--plain"], ["Vite", "npm", "AI:"]);
  expectRun("agent context django app", "django-app", ["doctor", "--plain"], ["Setupr Doctor", "AI Director Diagnosis"], { expectedExitCode: [0, 1] });
  expectRun("agent context fastapi app", "fastapi-app", ["info", "--plain"], ["Python", "FastAPI"]);
  expectRun("agent context rust app", "rust-app", ["info", "--plain"], ["Rust"]);
  expectRun("agent context go app", "go-app", ["info", "--plain"], ["Go"]);
  expectRun("agent context docker app", "docker-heavy", ["doctor", "--plain"], ["Setupr Doctor", "AI Director Diagnosis"]);
  expectRun("broken lock handled", "broken-lock", ["status", "--plain"], ["Setupr Status", "Dependencies"]);
	  expectRun("plugin api scaffold", "js-new", ["plugin", "create", "demo", "--plain", "--force"], ["Created Setupr plugin project"]);
	  expectRun("plugin api validate", "js-new", ["plugin", "validate", "setupr-plugin-demo", "--plain"], ["Manifest looks valid"]);
  expectProcessLifecycle();
	}

function tuiSmoke() {
  const hasExpect = spawnSync("bash", ["-lc", "command -v expect"], { encoding: "utf8" }).status === 0;
  if (!hasExpect) {
    results.push({ name: "tui doctor capture", ok: true, skipped: "expect is not installed" });
    return;
  }
  const expectFile = join(temp, "tui-doctor.expect");
	  writeFileSync(expectFile, [
	    "set timeout 10",
	    "set node [lindex $argv 0]",
	    "set cli [lindex $argv 1]",
	    "set cwd [lindex $argv 2]",
	    "cd $cwd",
	    "set env(COLUMNS) 80",
	    "set env(LINES) 24",
	    "spawn $node $cli doctor",
    "stty rows 24 columns 100",
    "expect {",
    "  -re \"Press Enter\" { send \"\\r\" }",
    "  timeout { send \"\\003\"; exit 1 }",
    "  eof { exit 1 }",
    "}",
    "expect {",
    "  -re \"(DIAGNOSTICS|ENVIRONMENT)\" {}",
    "  timeout { send \"\\003\"; exit 1 }",
    "  eof { exit 1 }",
    "}",
	    "after 1000",
	    "send \"\\003\"",
	    "expect eof",
    "",
  ].join("\n"));
  const result = spawnSync("expect", [expectFile, process.execPath, cli, join(temp, "tui-empty")], {
    encoding: "utf8",
    env: { ...cleanSmokeEnv(), TERM: "xterm-256color" },
    timeout: 25_000,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const ok = result.status === 0 && !result.error && !result.signal && /Setupr Doctor|Diagnostics|Environment|DIAGNOSTICS/.test(output);
	  if (ok) {
	    results.push({ name: "tui doctor capture", ok: true, details: "captured TUI launch text" });
	  } else {
	    results.push({
	      name: "tui doctor capture",
	      ok: false,
	      details: `doctor TUI did not render expected text\n${trim(output)}`,
	    });
	  }

  const envExpectFile = join(temp, "tui-env.expect");
  writeFileSync(envExpectFile, [
    "set timeout 10",
    "set node [lindex $argv 0]",
    "set cli [lindex $argv 1]",
    "set cwd [lindex $argv 2]",
    "cd $cwd",
    "set env(COLUMNS) 100",
    "set env(LINES) 28",
    "spawn $node $cli env --force",
    "expect {",
    "  -re \"No variables yet\" {}",
    "  timeout { send \"\\003\"; exit 1 }",
    "  eof { exit 1 }",
    "}",
    "send -- \"API_KEY=smoke-value\"",
    "after 100",
    "send -- \"\\r\"",
    "expect {",
    "  -re \"Saved 1 environment value|saved\" {}",
    "  timeout { send \"\\003\"; exit 1 }",
    "  eof { exit 1 }",
    "}",
    "send \"\\003\"",
    "after 500",
    "send \"\\003\"",
    "expect eof",
    "",
  ].join("\n"));
  const envResult = spawnSync("expect", [envExpectFile, process.execPath, cli, join(temp, "env-tui-force")], {
    encoding: "utf8",
    env: { ...cleanSmokeEnv(), TERM: "xterm-256color" },
    timeout: 25_000,
  });
  const envOutput = `${envResult.stdout || ""}\n${envResult.stderr || ""}`;
  const envFile = join(temp, "env-tui-force", ".env");
  const envOk = fileExists(envFile) && readFileSync(envFile, "utf8").includes("API_KEY=smoke-value") && /setupr env|Setupr Env|VARIABLES|ENV FILE/i.test(envOutput) && envResult.status === 0;
  results.push({
    name: "tui env editor capture",
    ok: envOk,
    details: envOk ? "opened editor and saved the typed value" : `env editor did not save the typed value\n${trim(envOutput)}`,
  });
}

function expectRun(name, fixture, args, expected, options = {}) {
  const result = run(fixture, args, options);
  const output = result.stdout + result.stderr;
  const missing = expected.filter((item) => !output.includes(item));
  const expectedExit = options.expectedExitCode ?? (errorCases.has(name) ? 1 : 0);
  const exitMatches = Array.isArray(expectedExit) ? expectedExit.includes(result.status) : result.status === expectedExit;
  const ok = missing.length === 0 && exitMatches && !result.error && !result.signal;
  results.push({
    name,
    ok,
    details: ok
      ? expected.join(", ")
      : `exit ${result.status} (expected ${expectedExit}); missing ${missing.join(", ")}\n${trim(output)}`,
  });
}

function expectNoFile(name, fixture, args, forbiddenPath, options = {}) {
  const result = run(fixture, args, options);
  results.push({
    name,
    ok: !fileExists(forbiddenPath) && result.status === 1 && !result.error && !result.signal && !`${result.stdout}${result.stderr}`.includes("MODULE_NOT_FOUND"),
    details: fileExists(forbiddenPath)
      ? `forbidden marker was created\n${trim(result.stdout + result.stderr)}`
      : "marker not created",
  });
}

function expectProcessLifecycle() {
  const start = run("process-lifecycle", ["start", "--plain", "--force"], { timeout: 20_000 });
  const psBefore = run("process-lifecycle", ["ps", "--plain"], { timeout: 10_000 });
  const stop = run("process-lifecycle", ["stop", "all", "--force"], { timeout: 10_000 });
  const psAfter = run("process-lifecycle", ["ps", "--plain"], { timeout: 10_000 });
  const output = [start, psBefore, stop, psAfter].map((result) => result.stdout + result.stderr).join("\n");
  const ok = [start, psBefore, stop, psAfter].every(result => result.status === 0 && !result.error && !result.signal) && output.includes("Started dev") && output.includes("running") && output.includes("Stopped dev") && output.includes("stopped");
  results.push({
    name: "process lifecycle start ps stop-all",
    ok,
    details: ok ? "started, listed, stopped all" : trim(output),
  });
}

function run(fixture, args, options = {}) {
	  return spawnSync(process.execPath, [cli, ...args], {
	    cwd: join(temp, fixture),
	    env: { ...cleanSmokeEnv(), ...(options.env || {}) },
	    encoding: "utf8",
	    timeout: options.timeout || 15_000,
	  });
	}

function cleanSmokeEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENAI|ANTHROPIC|GOOGLE|GROQ|MINIMAX|MOONSHOT|GITHUB|GH_|SETUPR_AI|P_SETUP|AI_)/i.test(key)) {
      delete env[key];
    }
  }
  const home = join(temp, "smoke-home");
  mkdirSync(home, { recursive: true });
  env.HOME = home;
  env.XDG_CONFIG_HOME = join(home, ".config");
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.SETUPR_SMOKE = "1";
  return env;
}

function report() {
  console.log(`\nSetupr fixture smoke`);
  console.log(`Fixtures: ${temp}${keep || results.some(result => !result.ok) ? " (retained)" : " (will be removed)"}`);
  let failed = 0;
  for (const result of results) {
    const marker = result.ok ? "✓" : "✗";
    const suffix = result.skipped ? ` - skipped: ${result.skipped}` : result.details ? ` - ${result.details}` : "";
    console.log(`${marker} ${result.name}${suffix}`);
    if (!result.ok) failed++;
  }
  console.log("");
  if (failed > 0) {
    console.error(`${failed} smoke check${failed === 1 ? "" : "s"} failed.`);
    process.exitCode = 1;
  } else {
    console.log(`${results.length} smoke checks passed.`);
  }
}

function dir(path) {
  mkdirSync(join(temp, path), { recursive: true });
}

function write(path, content) {
  writeFileSync(join(temp, path), content);
}

function fileExists(path) {
  try {
    return spawnSync("test", ["-e", path]).status === 0;
  } catch {
    return false;
  }
}

function trim(value) {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").slice(0, 1200);
}

main();
