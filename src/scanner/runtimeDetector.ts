import { readFile, access } from "fs/promises";
import { join } from "path";

export async function detectRuntime(
  cwd: string
): Promise<{ name: string; version: string | null } | null> {
  // Node.js version detection
  const nodeVersion = await detectNodeVersion(cwd);
  if (nodeVersion) return { name: "node", version: nodeVersion };

  // Python version
  const pyVersion = await detectPythonVersion(cwd);
  if (pyVersion) return { name: "python", version: pyVersion };

  // Ruby version
  const rubyVersion = await readVersionFile(cwd, ".ruby-version");
  if (rubyVersion) return { name: "ruby", version: rubyVersion };

  // Go version
  const goVersion = await detectGoVersion(cwd);
  if (goVersion) return { name: "go", version: goVersion };

  // Java version
  const javaVersion = await readVersionFile(cwd, ".java-version");
  if (javaVersion) return { name: "java", version: javaVersion };

  // Rust — no specific version file usually
  try {
    await access(join(cwd, "Cargo.toml"));
    return { name: "rust", version: null };
  } catch {}

  // Fallback: detect from package.json engines
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    if (pkg.engines?.node) return { name: "node", version: pkg.engines.node };
  } catch {}

  for (const file of ["pyproject.toml", "requirements.txt", "Pipfile", "poetry.lock", "setup.py", "setup.cfg"]) {
    try {
      await access(join(cwd, file));
      return { name: "python", version: null };
    } catch {}
  }

  return null;
}

async function detectNodeVersion(cwd: string): Promise<string | null> {
  // .nvmrc
  const nvmrc = await readVersionFile(cwd, ".nvmrc");
  if (nvmrc) return nvmrc;

  // .node-version
  const nodeVer = await readVersionFile(cwd, ".node-version");
  if (nodeVer) return nodeVer;

  // .tool-versions (asdf/mise)
  try {
    const content = await readFile(join(cwd, ".tool-versions"), "utf-8");
    const match = content.match(/nodejs\s+(.+)/);
    if (match) return match[1].trim();
  } catch {}

  // package.json volta
  try {
    const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
    if (pkg.volta?.node) return pkg.volta.node;
  } catch {}

  return null;
}

async function detectPythonVersion(cwd: string): Promise<string | null> {
  const pyVer = await readVersionFile(cwd, ".python-version");
  if (pyVer) return pyVer;

  try {
    const content = await readFile(join(cwd, ".tool-versions"), "utf-8");
    const match = content.match(/python\s+(.+)/);
    if (match) return match[1].trim();
  } catch {}

  try {
    const pyproject = await readFile(join(cwd, "pyproject.toml"), "utf-8");
    return readPythonConstraint(pyproject);
  } catch {}

  return null;
}

function readPythonConstraint(content: string): string | null {
  // Only inspect simple one-line fields before any multiline TOML string.
  // This deliberately does not decode escapes or attempt full TOML parsing.
  const lines = content.split(/"""|'''/, 1)[0].split(/\r?\n/);
  let section = "";
  let poetryVersion: string | null = null;
  for (const line of lines) {
    const table = line.match(/^\s*\[([\w.-]+)\]\s*(?:#.*)?$/);
    if (table) {
      section = table[1];
      continue;
    }
    if (line.trimStart().startsWith("[")) section = "";
    const field = line.match(/^\s*(requires-python|python)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (!field) continue;
    const value = (field[2] ?? field[3]).trim();
    if (section === "project" && field[1] === "requires-python") return value || null;
    if (section === "tool.poetry.dependencies" && field[1] === "python") poetryVersion = value || null;
  }
  return poetryVersion;
}

async function detectGoVersion(cwd: string): Promise<string | null> {
  try {
    const gomod = await readFile(join(cwd, "go.mod"), "utf-8");
    const match = gomod.match(/^go\s+(.+)$/m);
    if (match) return match[1].trim();
  } catch {}
  return null;
}

async function readVersionFile(cwd: string, filename: string): Promise<string | null> {
  try {
    const content = await readFile(join(cwd, filename), "utf-8");
    return content.trim() || null;
  } catch {
    return null;
  }
}
