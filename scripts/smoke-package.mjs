#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const supplied = process.argv.indexOf("--tarball");
if (supplied >= 0 && !process.argv[supplied + 1]) throw new Error("--tarball requires a path");
const temporary = mkdtempSync(join(tmpdir(), "setupr-package-"));
const isolatedHome = join(temporary, "home");
mkdirSync(isolatedHome);
const environment = {
  ...process.env,
  HOME: isolatedHome,
  XDG_CONFIG_HOME: join(isolatedHome, ".config"),
  NPM_CONFIG_USERCONFIG: join(temporary, "empty.npmrc"),
  NO_COLOR: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
writeFileSync(environment.NPM_CONFIG_USERCONFIG, "");
for (const key of Object.keys(environment)) {
  if (/^(OPENAI|ANTHROPIC|GOOGLE|GROQ|MINIMAX|MOONSHOT|GITHUB|GH_|SETUPR_AI|P_SETUP|AI_|NODE_AUTH_TOKEN|NPM_TOKEN)/i.test(key)) delete environment[key];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repo,
    env: environment,
    encoding: "utf8",
    timeout: options.timeout || 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `${command}: ${result.error?.message}`);
  assert.equal(result.signal, null, `${command} was interrupted`);
  assert.equal(result.status, options.code ?? 0, `${command} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
  return result;
}

try {
  let tarball;
  if (supplied >= 0) {
    tarball = resolve(process.argv[supplied + 1]);
  } else {
    const packed = run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { timeout: 60_000 });
    const [manifest] = JSON.parse(packed.stdout);
    assert.equal(manifest.name, packageInfo.name);
    assert.equal(manifest.version, packageInfo.version);
    tarball = join(temporary, manifest.filename);
  }
  assert.ok(existsSync(tarball), `Package tarball is missing: ${tarball}`);
  const archive = run("tar", ["-tzf", tarball]);
  const files = archive.stdout.trim().split("\n").filter(name => name && !name.endsWith("/"));
  assert.ok(files.includes("package/dist/setup.js"), "Built CLI is missing from the package");
  assert.ok(files.includes("package/README.md"), "README is missing from the package");
  for (const name of files) {
    assert.ok(name.startsWith("package/") && !name.split("/").includes(".."), `Unexpected archive path: ${name}`);
    assert.ok(
      /^package\/(?:dist\/setup\.js|docs\/[^/]+\.md|(?:README|SETUP|ENVREADME|TROUBLESHOOTING|SECURITY|CHANGELOG|CONTRIBUTING)\.md|LICENSE|package\.json|\.env\.example)$/.test(name),
      `Unexpected package file: ${name}`
    );
  }
  console.log(`PASS archive allowlist (${files.length} files)`);

  const prefix = join(temporary, "fresh install");
  run("npm", ["install", "--prefix", prefix, tarball, "--ignore-scripts", "--no-audit", "--no-fund"], { timeout: 180_000 });
  const installed = join(prefix, "node_modules", "@evan-coder", "setupr");
  const installedInfo = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  assert.equal(installedInfo.version, packageInfo.version);
  const executable = join(installed, "dist", "setup.js");
  assert.ok(existsSync(executable));
  if (process.platform !== "win32") {
    for (const binary of ["setupr", "setup"]) {
      assert.equal(realpathSync(join(prefix, "node_modules", ".bin", binary)), realpathSync(executable));
    }
  }
  console.log("PASS fresh install and both terminal commands");

  const fixture = join(temporary, "project with spaces");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fresh-project", version: "1.0.0", scripts: { test: "node --test" } }));
  const cli = (...args) => run(process.execPath, [executable, ...args], { cwd: fixture, timeout: 20_000 });
  assert.equal(cli("--version").stdout.trim(), packageInfo.version);
  assert.match(cli("help").stdout, /setupr setup/);
  assert.match(cli("info", "--plain").stdout, /fresh-project/);
  const status = JSON.parse(cli("status", "--plain", "--json").stdout);
  assert.equal(status.projectName, "fresh-project");
  console.log("PASS installed CLI version, help, info, and JSON status");

  writeFileSync(join(fixture, "package.json"), "{broken json");
  const malformed = run(process.execPath, [executable, "info", "--plain"], { cwd: fixture, code: 1 });
  assert.match(malformed.stdout + malformed.stderr, /MALFORMED_PROJECT_FILE/);
  console.log("PASS installed CLI reports malformed project files");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
