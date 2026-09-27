import chalk from "chalk";
import { mkdir, readFile, realpath, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { hasMagic } from "glob";
import { runCommand } from "../../executor/index.js";
import { createSetuprError, fromUnknownError, printPlainError } from "../../errors/index.js";
import { scanProject, type ScanResult } from "../../scanner/index.js";
import { readWorkspacePatterns, workspacePathMatches } from "../../scanner/monorepoDetector.js";
import { shellQuote } from "../../util/shell.js";

interface WorkspaceFlags {
  force?: boolean;
  args?: string[];
  filter?: string;
  [key: string]: unknown;
}

export async function cmdWorkspace(sub: string | undefined, cwd: string, flags: WorkspaceFlags): Promise<void> {
  switch (sub) {
    case "list": return workspaceList(cwd);
    case "run": return workspaceRun(cwd, flags);
    case "exec": return workspaceExec(cwd, flags);
    case "add": return workspaceAdd(cwd, flags);
    case "info": return workspaceInfo(cwd);
    case "check": return workspaceCheck(cwd);
    default:
      printPlainError(createSetuprError({
        code: "UNKNOWN_SUBCOMMAND",
        command: "workspace",
        subcommand: sub,
        cwd,
        details: ["Valid: list, run <script>, exec <cmd>, add <name>, info, check"],
      }));
  }
}

interface WorkspacePackage {
  name: string;
  path: string;
  version: string;
}

async function getWorkspacePackages(cwd: string, scan?: ScanResult): Promise<WorkspacePackage[]> {
  const result = scan ?? await scanProject(cwd);
  const packages: WorkspacePackage[] = [];
  for (const pkgPath of result.monorepo?.packages ?? []) {
    let name = pkgPath;
    let version = "0.0.0";
    try {
      const pkg = JSON.parse(await readFile(join(cwd, pkgPath, "package.json"), "utf-8"));
      if (typeof pkg?.name === "string" && pkg.name) name = pkg.name;
      if (typeof pkg?.version === "string" && pkg.version) version = pkg.version;
    } catch {
      // Keep unreadable packages in the targets so execution reports their failure.
    }
    packages.push({ name, path: pkgPath, version });
  }
  return packages;
}

function selectPackages(packages: WorkspacePackage[], filter: string | undefined, cwd: string, subcommand: string): WorkspacePackage[] {
  if (filter !== undefined && !filter.trim()) {
    printPlainError(createSetuprError({
      code: "INVALID_ARGUMENT", command: "workspace", subcommand, cwd,
      details: ["The workspace filter must not be empty."],
    }));
    return [];
  }
  const targets = filter === undefined
    ? packages
    : packages.filter(pkg => pkg.name.includes(filter) || pkg.path.includes(filter));
  if (targets.length === 0) {
    printPlainError(createSetuprError({
      code: "WORKSPACE_NO_PACKAGES", command: "workspace", subcommand, cwd,
      details: filter === undefined ? [] : [`No workspace packages match filter: ${filter}`],
    }));
  }
  return targets;
}

function commandSummary(cwd: string, subcommand: string, passed: number, failed: number, skipped = 0): void {
  console.log("");
  if (failed > 0) {
    printPlainError(createSetuprError({
      code: "WORKSPACE_COMMAND_FAILED", command: "workspace", subcommand, cwd,
      details: [`${failed} package(s) failed, ${passed} passed, ${skipped} skipped`],
    }));
  } else if (passed === 0) {
    printPlainError(createSetuprError({
      code: "MISSING_SCRIPT", command: "workspace", subcommand, cwd,
      details: [`No selected package contains the requested script; ${skipped} skipped.`],
    }));
  } else {
    console.log(chalk.green(`✓ ${passed} package(s) passed, ${skipped} skipped`));
  }
}

async function workspaceList(cwd: string): Promise<void> {
  const packages = await getWorkspacePackages(cwd);

  if (packages.length === 0) {
    printPlainError(createSetuprError({ code: "WORKSPACE_NO_PACKAGES", command: "workspace", subcommand: "list", cwd }));
    return;
  }

  console.log(chalk.blue.bold("\n  Workspace Packages\n"));
  for (const pkg of packages) {
    console.log(`  ${chalk.green(pkg.name.padEnd(30))} ${chalk.dim(pkg.version.padEnd(10))} ${chalk.dim(pkg.path)}`);
  }
  console.log(chalk.dim(`\n  ${packages.length} package(s)`));
}

async function workspaceRun(cwd: string, flags: WorkspaceFlags): Promise<void> {
  const script = flags.args?.[0];
  if (!script) {
    printPlainError(createSetuprError({
      code: "MISSING_SCRIPT", command: "workspace", subcommand: "run", cwd,
      details: ["Usage: setupr workspace run <script> [--filter=<package>]"],
    }));
    return;
  }
  if (script.startsWith("-") || script.includes("\0")) {
    printPlainError(createSetuprError({
      code: "INVALID_ARGUMENT", command: "workspace", subcommand: "run", cwd,
      details: ["Script names must not start with '-' or contain null bytes."],
    }));
    return;
  }

  const scan = await scanProject(cwd);
  const packages = await getWorkspacePackages(cwd, scan);
  const targets = selectPackages(packages, flags.filter ?? flags.args?.[1], cwd, "run");
  if (targets.length === 0) return;

  const pm = scan.packageManager || "npm";
  if (!["npm", "pnpm", "yarn", "bun"].includes(pm)) {
    printPlainError(createSetuprError({
      code: "INVALID_ARGUMENT", command: "workspace", subcommand: "run", cwd,
      details: [`Unsupported workspace package manager: ${pm}`],
    }));
    return;
  }

  console.log(chalk.blue(`Running "${script}" across ${targets.length} package(s)...\n`));

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const pkg of targets) {
    const pkgDir = join(cwd, pkg.path);
    try {
      const child = await scanProject(pkgDir);
      if (!Object.prototype.hasOwnProperty.call(child.scripts, script)) {
        console.log(chalk.dim(`  ○ ${pkg.name} — no "${script}" script`));
        skipped++;
        continue;
      }

      const result = await runCommand(`${pm} run ${shellQuote(script)}`, pkgDir);
      if (result.exitCode === 0) {
        console.log(chalk.green(`  ✓ ${pkg.name}`));
        passed++;
      } else {
        console.log(chalk.red(`  ✗ ${pkg.name}`));
        if (result.stderr) console.log(chalk.dim(`    ${result.stderr.split("\n")[0]}`));
        failed++;
      }
    } catch (error) {
      console.log(chalk.red(`  ✗ ${pkg.name}`));
      printPlainError(fromUnknownError(error, { command: "workspace", subcommand: "run", cwd: pkgDir }));
      failed++;
    }
  }

  commandSummary(cwd, "run", passed, failed, skipped);
}

async function workspaceExec(cwd: string, flags: WorkspaceFlags): Promise<void> {
  const cmd = flags.args?.join(" ");
  if (!cmd?.trim()) {
    printPlainError(createSetuprError({
      code: "INVALID_ARGUMENT", command: "workspace", subcommand: "exec", cwd,
      details: ["Usage: setupr workspace exec <command> [--filter=<package>]"],
    }));
    return;
  }

  if (!/^[a-zA-Z0-9\s._/-]+$/.test(cmd)) {
    printPlainError(createSetuprError({ code: "COMMAND_FAILED", command: "workspace", subcommand: "exec", cwd, details: ["Invalid command characters."] }));
    return;
  }

  const packages = await getWorkspacePackages(cwd);
  const targets = selectPackages(packages, flags.filter, cwd, "exec");
  if (targets.length === 0) return;
  console.log(chalk.blue(`Executing in ${targets.length} package(s): ${cmd}\n`));

  let passed = 0;
  let failed = 0;
  for (const pkg of targets) {
    const pkgDir = join(cwd, pkg.path);
    try {
      await scanProject(pkgDir);
      const result = await runCommand(cmd, pkgDir);
      const icon = result.exitCode === 0 ? chalk.green("✓") : chalk.red("✗");
      console.log(`  ${icon} ${pkg.name}`);
      if (result.exitCode === 0) passed++;
      else {
        if (result.stderr) console.log(chalk.dim(`    ${result.stderr.split("\n")[0]}`));
        failed++;
      }
    } catch (error) {
      console.log(chalk.red(`  ✗ ${pkg.name}`));
      printPlainError(fromUnknownError(error, { command: "workspace", subcommand: "exec", cwd: pkgDir }));
      failed++;
    }
  }
  commandSummary(cwd, "exec", passed, failed);
}

async function workspaceAdd(cwd: string, flags: WorkspaceFlags): Promise<void> {
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(createSetuprError({
      code: "MISSING_PACKAGE", command: "workspace", subcommand: "add", cwd,
      details: ["Usage: setupr workspace add <package-name>"],
    }));
    return;
  }

  try {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name.length > 214) {
      throw createSetuprError({
        code: "INVALID_ARGUMENT",
        details: ["Use a lowercase package basename, not a path (letters, digits, dots, underscores, and hyphens)."],
      });
    }
    await scanProject(cwd);
    const rootPkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    const patterns = await readWorkspacePatterns(cwd);
    const pattern = patterns?.find(value => !value.startsWith("!"))?.replace(/\/+$/, "");
    const base = pattern?.endsWith("/*") ? pattern.slice(0, -2) : undefined;
    if (!patterns || !base || hasMagic(base, { magicalBraces: true })) {
      throw createSetuprError({
        code: "INVALID_ARGUMENT",
        details: ["Workspace add requires a first positive workspace pattern ending in /* with a literal parent directory."],
      });
    }
    const rootDir = await realpath(cwd);
    const baseDir = resolve(rootDir, base);
    assertContained(rootDir, baseDir);
    const pkgPath = relative(rootDir, join(baseDir, name)).split(sep).join("/");
    if (!workspacePathMatches(pkgPath, patterns)) {
      throw createSetuprError({ code: "INVALID_ARGUMENT", details: [`Workspace patterns exclude ${pkgPath}.`] });
    }

    const rootName = typeof rootPkg.name === "string" && rootPkg.name ? rootPkg.name : "workspace";
    const scope = rootName.startsWith("@") ? rootName.slice(1).split("/")[0] : rootName;
    const packageName = `@${scope}/${name}`;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(scope) || packageName.length > 214) {
      throw createSetuprError({ code: "INVALID_ARGUMENT", details: [`Cannot create a valid package name from root name: ${rootName}`] });
    }

    const parentDir = await createContainedDirectory(rootDir, baseDir);
    const pkgDir = join(parentDir, name);
    // An exclusive mkdir also rejects existing files, directories, and dangling symlinks.
    try {
      await mkdir(pkgDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw createSetuprError({
        code: "INVALID_ARGUMENT", details: [`Destination already exists: ${pkgPath}. No files were overwritten.`],
      });
    }
    await mkdir(join(pkgDir, "src"));
    const pkg = {
      name: packageName,
      version: "0.1.0",
      type: "module",
      main: "./dist/index.js",
      scripts: { build: "tsc", dev: "tsc --watch", test: "echo 'no tests'" },
    };
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(pkg, null, 2) + "\n", { flag: "wx" });
    const identifier = `package_${name.replace(/[.-]/g, "_")}`;
    await writeFile(join(pkgDir, "src/index.ts"), `export const ${identifier} = true;\n`, { flag: "wx" });

    console.log(chalk.green(`✓ Created workspace package: ${pkg.name}`));
    console.log(chalk.dim(`  Path: ${pkgPath}`));
  } catch (error) {
    printPlainError(fromUnknownError(error, { command: "workspace", subcommand: "add", cwd }));
  }
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw createSetuprError({ code: "INVALID_ARGUMENT", details: ["Workspace package paths must stay inside the workspace root."] });
  }
}

async function createContainedDirectory(root: string, path: string): Promise<string> {
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    const next = join(current, part);
    try {
      await mkdir(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    current = await realpath(next);
    assertContained(root, current);
  }
  return current;
}

async function workspaceInfo(cwd: string): Promise<void> {
  const scan = await scanProject(cwd);
  const packages = await getWorkspacePackages(cwd, scan);

  console.log(chalk.blue.bold("\n  Workspace Info\n"));
  console.log(`  Type:      ${chalk.white(scan.monorepo?.type || "npm workspaces")}`);
  console.log(`  Packages:  ${chalk.white(String(packages.length))}`);
  console.log(`  PM:        ${chalk.white(scan.packageManager || "npm")}`);

  if (packages.length > 0) {
    console.log(chalk.dim("\n  Packages:"));
    for (const pkg of packages.slice(0, 10)) {
      console.log(chalk.dim(`    ${pkg.name} (${pkg.version})`));
    }
    if (packages.length > 10) {
      console.log(chalk.dim(`    ... and ${packages.length - 10} more`));
    }
  }
  console.log("");
}

async function workspaceCheck(cwd: string): Promise<void> {
  const packages = await getWorkspacePackages(cwd);
  if (packages.length === 0) {
    printPlainError(createSetuprError({ code: "WORKSPACE_NO_PACKAGES", command: "workspace", subcommand: "check", cwd }));
    return;
  }

  console.log(chalk.blue.bold("\n  Workspace Health Check\n"));
  let issues = 0;

  for (const pkg of packages) {
    const pkgDir = join(cwd, pkg.path);
    const checks: string[] = [];

    if (!existsSync(join(pkgDir, "package.json"))) { checks.push("missing package.json"); issues++; }
    if (!existsSync(join(pkgDir, "src")) && !existsSync(join(pkgDir, "lib"))) { checks.push("no src/ or lib/"); issues++; }

    const icon = checks.length === 0 ? chalk.green("✓") : chalk.yellow("⚠");
    console.log(`  ${icon} ${pkg.name}${checks.length > 0 ? chalk.dim(` — ${checks.join(", ")}`) : ""}`);
  }

  console.log("");
  if (issues === 0) {
    console.log(chalk.green("  ✓ All packages look good"));
  } else {
    console.log(chalk.yellow(`  ${issues} issue(s) found`));
  }
}
