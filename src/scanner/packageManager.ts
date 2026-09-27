import { access, readFile } from "fs/promises";
import { join } from "path";

const LOCK_FILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "package-lock.json": "npm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "deno.lock": "deno",
};

export async function detectPackageManager(cwd: string): Promise<string | null> {
  // Check package.json packageManager field first
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    if (pkg.packageManager) {
      const pm = pkg.packageManager.split("@")[0];
      if (["npm", "yarn", "pnpm", "bun"].includes(pm)) return pm;
    }
  } catch {}

  // Check lock files
  for (const [file, pm] of Object.entries(LOCK_FILES)) {
    try {
      await access(join(cwd, file));
      return pm;
    } catch {}
  }

  // Check pnpm-workspace.yaml (monorepo without lockfile yet)
  try {
    await access(join(cwd, "pnpm-workspace.yaml"));
    return "pnpm";
  } catch {}

  // Fallback: if package.json exists, assume npm
  try {
    await access(join(cwd, "package.json"));
    return "npm";
  } catch {}

  // Python package managers
  try {
    await access(join(cwd, "Pipfile"));
    return "pipenv";
  } catch {}
  try {
    await access(join(cwd, "poetry.lock"));
    return "poetry";
  } catch {}
  try {
    await access(join(cwd, "requirements.txt"));
    return "pip";
  } catch {}
  try {
    const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf-8");
    // Do not infer an installable package from tool-only configuration or string contents.
    const simpleMetadata = pyproject.split(/"""|'''/, 1)[0];
    if (/^\s*\[(?:project|build-system)\]\s*(?:#.*)?$/m.test(simpleMetadata)) return "pip";
  } catch {}

  // Other
  try {
    await access(join(cwd, "Cargo.toml"));
    return "cargo";
  } catch {}
  try {
    await access(join(cwd, "go.mod"));
    return "go";
  } catch {}
  try {
    await access(join(cwd, "Gemfile"));
    return "bundler";
  } catch {}
  try {
    await access(join(cwd, "composer.json"));
    return "composer";
  } catch {}
  try {
    await access(join(cwd, "pubspec.yaml"));
    return "pub";
  } catch {}
  try {
    await access(join(cwd, "mix.exs"));
    return "mix";
  } catch {}

  return null;
}
