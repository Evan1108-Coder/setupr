import { detectFromConfig } from "./configDetector.js";
import { detectLanguage } from "./languageDetector.js";
import { detectFramework } from "./frameworkDetector.js";
import { detectPackageManager } from "./packageManager.js";
import { detectRuntime } from "./runtimeDetector.js";
import { detectServices } from "./serviceDetector.js";
import { detectMonorepo } from "./monorepoDetector.js";
import { readProjectJsonFile } from "./projectValidation.js";

export interface ScanResult {
  language: string | null;
  framework: string | null;
  packageManager: string | null;
  runtime: { name: string; version: string | null } | null;
  services: string[];
  monorepo: { type: string; packages: string[] } | null;
  scripts: Record<string, string>;
  dependencies: { prod: number; dev: number };
  configFiles: string[];
}

function normalizeRuntime(
  runtime: string | { name?: string; version?: string | null } | undefined
): ScanResult["runtime"] | null {
  if (!runtime) return null;
  if (typeof runtime === "string") return { name: runtime, version: null };
  if (!runtime.name) return null;
  return { name: runtime.name, version: runtime.version ?? null };
}

export async function scanProject(cwd: string): Promise<ScanResult> {
  await validateProjectFiles(cwd);
  const configResult = await detectFromConfig(cwd);
  const configuredRuntime = normalizeRuntime(configResult?.runtime);

  const results = await Promise.allSettled([
    configResult?.language
      ? Promise.resolve(configResult.language)
      : detectLanguage(cwd),
    configResult?.framework
      ? Promise.resolve(configResult.framework)
      : detectFramework(cwd),
    configResult?.packageManager
      ? Promise.resolve(configResult.packageManager)
      : detectPackageManager(cwd),
    configuredRuntime
      ? Promise.resolve(configuredRuntime)
      : detectRuntime(cwd),
    detectServices(cwd),
    detectMonorepo(cwd),
  ]);

  const settled = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === "fulfilled" ? r.value : fallback;

  const language = settled(results[0], null) as string | null;
  const framework = settled(results[1], null) as string | null;
  const packageManager = settled(results[2], null) as string | null;
  const runtime = settled(results[3], null) as ScanResult["runtime"];
  const services = settled(results[4], []) as string[];
  if (results[5].status === "rejected") throw results[5].reason;
  const monorepo = settled(results[5], null) as ScanResult["monorepo"];

  const scripts = await getScripts(cwd, packageManager);
  const deps = await getDependencyCounts(cwd);
  const configFiles = await findConfigFiles(cwd);

  return {
    language: configResult?.language || language,
    framework: configResult?.framework || framework,
    packageManager: configResult?.packageManager || packageManager,
    runtime: configuredRuntime || runtime,
    services,
    monorepo,
    scripts,
    dependencies: deps,
    configFiles,
  };
}

async function validateProjectFiles(cwd: string): Promise<void> {
  for (const file of ["package.json", ".setupr.json", "lerna.json"]) {
    await readProjectJsonFile(cwd, file);
  }
}

async function getScripts(
  cwd: string,
  pm: string | null
): Promise<Record<string, string>> {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");
  try {
    if (pm === "npm" || pm === "yarn" || pm === "pnpm" || pm === "bun") {
      const pkg = JSON.parse(
        await readFile(join(cwd, "package.json"), "utf-8")
      );
      return pkg.scripts || {};
    }
  } catch {}
  return {};
}

async function getDependencyCounts(
  cwd: string
): Promise<{ prod: number; dev: number }> {
  const { readFile } = await import("fs/promises");
  const { join } = await import("path");

  // Try package.json first
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    const prod = Object.keys(pkg.dependencies || {}).length;
    const dev = Object.keys(pkg.devDependencies || {}).length;
    if (prod > 0 || dev > 0) return { prod, dev };
  } catch {}

  // Try requirements.txt (Python)
  try {
    const content = await readFile(join(cwd, "requirements.txt"), "utf-8");
    const deps = content.split("\n").filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("-"));
    return { prod: deps.length, dev: 0 };
  } catch {}

  // Try Cargo.toml (Rust)
  try {
    const content = await readFile(join(cwd, "Cargo.toml"), "utf-8");
    let prod = 0, dev = 0;
    let section = "";
    for (const line of content.split("\n")) {
      if (line.startsWith("[")) section = line;
      else if (section === "[dependencies]" && line.includes("=") && line.trim() && !line.trim().startsWith("#")) prod++;
      else if (section === "[dev-dependencies]" && line.includes("=") && line.trim() && !line.trim().startsWith("#")) dev++;
    }
    return { prod, dev };
  } catch {}

  // Try go.mod (Go)
  try {
    const content = await readFile(join(cwd, "go.mod"), "utf-8");
    let inRequireBlock = false;
    let count = 0;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("require (")) { inRequireBlock = true; continue; }
      if (trimmed === ")" && inRequireBlock) { inRequireBlock = false; continue; }
      if (inRequireBlock && trimmed && !trimmed.startsWith("//") && trimmed.includes("/")) { count++; continue; }
      if (trimmed.startsWith("require ") && !trimmed.includes("(") && trimmed.includes("/")) { count++; }
    }
    return { prod: count, dev: 0 };
  } catch {}

  return { prod: 0, dev: 0 };
}

async function findConfigFiles(cwd: string): Promise<string[]> {
  const { readdir } = await import("fs/promises");
  const configs: string[] = [];
  const known = [
    "package.json",
    "pnpm-workspace.yaml",
    "turbo.json",
    "lerna.json",
    "nx.json",
    "tsconfig.json",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "webpack.config.js",
    ".eslintrc.json",
    ".eslintrc.js",
    "eslint.config.js",
    ".prettierrc",
    "prettier.config.js",
    "jest.config.ts",
    "vitest.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
    ".env.example",
    ".env.local",
    "Makefile",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "setup.py",
    "requirements.txt",
    "Gemfile",
    "mix.exs",
    "pubspec.yaml",
    "composer.json",
    ".setupr.json",
  ];
  try {
    const files = await readdir(cwd);
    for (const f of files) {
      if (known.includes(f)) configs.push(f);
    }
  } catch {}
  return configs;
}
