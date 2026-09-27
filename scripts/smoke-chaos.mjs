#!/usr/bin/env node
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTestProjects } from "./create-test-projects.mjs";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = resolve(process.env.SETUPR_TEST_CLI || join(repo, "dist/setup.js"));
const args = process.argv.slice(2);
const sourceIndex = args.indexOf("--fixtures");
if (sourceIndex >= 0 && !args[sourceIndex + 1]) throw new Error("--fixtures requires a directory.");
const temp = mkdtempSync(join(tmpdir(), "setupr-chaos-"));
const root = join(temp, "projects");
if (sourceIndex >= 0) {
  const source = resolve(args[sourceIndex + 1]);
  const manifest = JSON.parse(readFileSync(join(source, "fixtures.json"), "utf8"));
  assert.equal(manifest.version, 1, "Unsupported fixture directory");
  cpSync(source, root, { recursive: true });
} else createTestProjects(root);
const isolatedHome = join(temp, "home");
mkdirSync(isolatedHome);
const env = { ...process.env, HOME: isolatedHome, XDG_CONFIG_HOME: join(isolatedHome, ".config"), NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
for (const key of Object.keys(env)) {
  if (/^(OPENAI|ANTHROPIC|GOOGLE|GROQ|MINIMAX|MOONSHOT|GITHUB|GH_|SETUPR_AI|P_SETUP|AI_|FORCE_COLOR)/i.test(key)) delete env[key];
}
const results = [];
function run(project, command) {
  return spawnSync(process.execPath, [cli, ...command], { cwd: join(root, project), env, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
}
function check(name, project, command, { code = 0, text = [], verify } = {}) {
  const started = Date.now();
  const result = run(project, command);
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  try {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null, "Command was killed");
    assert.equal(result.status, code, `Expected exit ${code}, got ${result.status}`);
    for (const expected of text) assert.ok(output.includes(expected), `Missing output: ${expected}`);
    verify?.(output, result);
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message, output: output.slice(-3000) });
    console.error(`FAIL ${name}: ${error.message}\n${output.slice(-1500)}`);
  }
}

try {
  assert.ok(existsSync(cli), "Build the CLI before running fixtures");
  for (const command of ["dashboard", "setup", "chat", "status", "start", "ps", "stop", "restart", "doctor", "update", "clean", "env", "auth", "info", "list", "run", "switch", "add", "remove", "port", "deps", "config", "lock", "diff", "logs", "test", "security", "fix", "release", "perf", "github", "registry", "build", "deploy", "open", "git", "init", "migrate", "ci", "docker", "secrets", "templates", "workspace", "health", "share", "notes", "history", "context", "plugin", "lint", "format"]) {
    check(`help ${command}`, "empty", [command, "--help"], { text: ["setupr"] });
  }
  for (const [project, code] of [["malformed-package", "MALFORMED_PROJECT_FILE"], ["invalid-package-shape", "MALFORMED_PROJECT_FILE"], ["invalid-config", "PROJECT_CONFIG_INVALID"], ["bad-workspace-yaml", "MALFORMED_PROJECT_FILE"]]) {
    check(`reject ${project}`, project, ["info", "--plain"], { code: 1, text: [code] });
  }
  for (const [project, labels] of [["next-app", ["Next.js"]], ["vite-app", ["Vite"]], ["django-app", ["Python", "Django"]], ["fastapi-app", ["Python", "FastAPI"]], ["rust-app", ["Rust"]], ["go-app", ["Go"]], ["docker-heavy", ["Docker"]], ["project with spaces", ["JavaScript", "npm"]]]) {
    check(`inspect ${project}`, project, ["info", "--plain"], { text: labels });
  }
  check("empty setup fails clearly", "empty", ["setup", "--plain", "--force"], { code: 1, text: ["NO_PROJECT_DETECTED"] });
  for (const project of ["healthy-node", "broken-lock", "corrupt-state", "git-upstream-only"]) {
    check(`JSON status ${project}`, project, ["status", "--plain", "--json"], { verify: (_, result) => assert.ok(JSON.parse(result.stdout).cwd) });
  }
  check("fork remote default", "git-multiple", ["github", "status", "--plain", "--json"], { text: ["fixture-user/fork.project", "origin"] });
  check("explicit upstream", "git-multiple", ["github", "status", "--remote", "upstream", "--plain", "--json"], { text: ["fixture-team/original.project", "upstream"] });
  check("upstream-only repository", "git-upstream-only", ["github", "status", "--plain", "--json"], { text: ["fixture-team/original.project"] });
  check("GitLab origin with GitHub upstream", "git-mixed-hosts", ["github", "status", "--plain", "--json"], { text: ["fixture-team/original.project"] });
  check("unknown remote cannot silently fall back", "git-multiple", ["github", "status", "--remote", "missing", "--plain"], { code: 1, text: ["GIT_REMOTE_MISSING"] });
  for (const project of ["npm-monorepo", "pnpm-monorepo"]) {
    check(`workspace discovery ${project}`, project, ["workspace", "list", "--plain"], { text: ["@fixture/api", "@fixture/ui", "2 package(s)"], verify: output => assert.ok(!output.includes("excluded")) });
  }
  check("workspace scripts", "npm-monorepo", ["workspace", "run", "test", "--plain"], { text: ["2 package(s) passed"] });
  check("workspace --filter", "npm-monorepo", ["workspace", "run", "test", "--filter", "@fixture/api", "--plain"], { text: ["1 package(s) passed"] });
  check("workspace empty filter reports failure", "npm-monorepo", ["workspace", "run", "test", "--filter", "not-a-package", "--plain"], { code: 1 });
  check("workspace exec propagates failure", "npm-monorepo", ["workspace", "exec", "node", "does-not-exist.cjs", "--plain"], { code: 1, text: ["WORKSPACE_COMMAND_FAILED"] });
  check("workspace add rejects traversal", "npm-monorepo", ["workspace", "add", "../../escaped", "--plain"], { code: 1, verify: () => assert.ok(!existsSync(join(root, "escaped"))) });
  const beforeWorkspace = readFileSync(join(root, "npm-monorepo/packages/api/package.json"), "utf8");
  check("workspace add refuses overwrite", "npm-monorepo", ["workspace", "add", "api", "--force", "--plain"], { code: 1, verify: () => assert.equal(readFileSync(join(root, "npm-monorepo/packages/api/package.json"), "utf8"), beforeWorkspace) });
  check("workspace add hyphenated package", "npm-monorepo", ["workspace", "add", "shared-utils", "--plain"], { text: ["Created workspace package"] });
  check("env no example error", "env-without-template", ["env", "init", "--plain"], { code: 1, text: ["ENV_TEMPLATE_MISSING"], verify: () => assert.ok(!existsSync(join(root, "env-without-template/.env"))) });
  check("env force explicit empty file", "env-without-template", ["env", "init", "--force", "--plain"], { text: ["Created empty .env"], verify: () => assert.ok(readFileSync(join(root, "env-without-template/.env"), "utf8").split(/\r?\n/).every(line => !line.trim() || line.startsWith("#"))) });
  const envBefore = readFileSync(join(root, "env-preservation/.env"), "utf8");
  check("env sync preserves data", "env-preservation", ["env", "sync", "--plain"], { verify: () => {
    const current = readFileSync(join(root, "env-preservation/.env"), "utf8");
    assert.ok(current.startsWith(envBefore)); assert.ok(current.includes("NEW_SETTING=enabled"));
  } });
  check("env malformed values", "many-problems", ["env", "smart", "--plain"], { code: 1, text: ["ENV_SMART_FAILED"] });
  check("env init from template", "healthy-node", ["env", "init", "--plain"], { text: ["Created .env"] });
  check("env check", "healthy-node", ["env", "check", "--plain"], { text: ["All environment variables are set"] });
  check("build in path with spaces", "project with spaces", ["build", "--plain"], { text: ["fixture build passed"] });
  check("test quick success", "healthy-node", ["test", "quick", "--plain"], { text: ["pass"] });
  check("test failure exit", "many-problems", ["test", "--plain"], { code: 1, text: ["fail"] });
  check("missing build file", "many-problems", ["build", "--plain"], { code: 1 });
  check("test list JSON", "healthy-node", ["test", "list", "--plain", "--json"], { verify: (_, result) => JSON.parse(result.stdout) });
  check("test report", "healthy-node", ["test", "report", "--plain"], { text: ["Setupr Test"] });
  check("security JSON", "docker-heavy", ["security", "quick", "--plain", "--json"], { verify: (_, result) => JSON.parse(result.stdout) });
  check("notes add", "healthy-node", ["notes", "add", "Fixture onboarding note", "--plain"], { text: ["note"] });
  check("notes list", "healthy-node", ["notes", "list", "--plain"], { text: ["Fixture onboarding note"] });
  check("history JSON", "corrupt-state", ["history", "--json", "--plain"], { verify: (_, result) => JSON.parse(result.stdout) });
  check("lock snapshot", "healthy-node", ["lock", "--plain"]);
  check("compare lock", "healthy-node", ["diff", "--plain"]);
  check("plugin template", "healthy-node", ["plugin", "create", "fixture", "--plain"], { text: ["Created Setupr plugin project"] });
  check("plugin validate", "healthy-node", ["plugin", "validate", "setupr-plugin-fixture", "--plain"], { text: ["Manifest looks valid"] });
  check("initialize encrypted project secrets", "healthy-node", ["secrets", "init", "--plain"]);
  const secret = "synthetic-password#with spaces";
  check("save secret without history leakage", "healthy-node", ["secrets", "set", "DATABASE_PASSWORD", secret, "--plain"], { verify: () => {
    const history = readFileSync(join(root, "healthy-node/.setupr/history.jsonl"), "utf8");
    assert.ok(!history.includes(secret), "Secret leaked into command history");
    assert.ok(!readFileSync(join(root, "healthy-node/.setupr/secrets.enc"), "utf8").includes(secret));
  } });
  check("secret list does not expose password prefix", "healthy-node", ["secrets", "list", "--plain"], { text: ["DATABASE_PASSWORD", "[hidden]"], verify: output => assert.ok(!output.includes("synthetic-password")) });
  check("explicit secret retrieval", "healthy-node", ["secrets", "get", "DATABASE_PASSWORD", "--plain"], { text: [secret] });
  check("secret export quotes hash values", "healthy-node", ["secrets", "export", "secrets-output.env", "--plain"], { verify: () => assert.ok(readFileSync(join(root, "healthy-node/secrets-output.env"), "utf8").includes(`DATABASE_PASSWORD="${secret}"`)) });
  check("secret missing value is an error", "healthy-node", ["secrets", "set", "MISSING_VALUE", "--plain"], { code: 1, text: ["SECRETS_ENCRYPTION_FAILED"] });
  check("secret missing import is an error", "healthy-node", ["secrets", "import", "absent.env", "--plain"], { code: 1 });
  check("start real loopback process", "process-stable", ["start", "--force", "--plain"], { text: ["Started"] });
  check("managed process running", "process-stable", ["ps", "--plain"], { text: ["running"] });
  check("managed process logs", "process-stable", ["logs", "--plain"], { text: ["fixture listening"] });
  check("restart real process", "process-stable", ["restart", "--force", "--plain"], { text: ["Restarted"] });
  check("stop real process", "process-stable", ["stop", "all", "--force", "--plain"], { text: ["Stopped"] });
  check("managed process stopped", "process-stable", ["ps", "--plain"], { text: ["stopped"] });
  check("startup crash", "process-crash", ["start", "--force", "--plain"], { code: 3, text: ["COMMAND_FAILED", "Process failed to start"] });
} finally {
  for (const project of ["process-stable", "process-crash"]) run(project, ["stop", "all", "--force", "--plain"]);
  const failures = results.filter(result => !result.ok);
  writeFileSync(join(temp, "results.json"), JSON.stringify({ cli, results }, null, 2));
  console.log(`\n${results.length - failures.length}/${results.length} chaos checks passed. Report: ${join(temp, "results.json")}`);
  if (failures.length) process.exitCode = 1;
  if (!failures.length && !args.includes("--keep")) rmSync(temp, { recursive: true, force: true });
}
