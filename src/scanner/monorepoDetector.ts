import { readFile, realpath, stat } from "fs/promises";
import { isAbsolute, join, relative, sep } from "path";
import { glob } from "glob";
import { minimatch } from "minimatch";
import { parseDocument } from "yaml";
import { createSetuprError } from "../errors/index.js";
import { readProjectJsonFile, validateWorkspacePatterns } from "./projectValidation.js";

interface WorkspaceDefinition { type: string; patterns: string[] }

export async function detectMonorepo(cwd: string): Promise<{ type: string; packages: string[] } | null> {
  const definition = await workspaceDefinition(cwd);
  return definition ? { type: definition.type, packages: await resolveWorkspacePackages(cwd, definition.patterns) } : null;
}

export async function readWorkspacePatterns(cwd: string): Promise<string[] | null> {
  return (await workspaceDefinition(cwd))?.patterns ?? null;
}

export function workspacePathMatches(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/^\.\//, "").replace(/\/$/, "");
  const matches = (pattern: string) => minimatch(normalized, pattern.replace(/^\.\//, "").replace(/\/$/, ""), { dot: false, nonegate: true });
  return patterns.some((pattern) => !pattern.startsWith("!") && matches(pattern))
    && !patterns.some((pattern) => pattern.startsWith("!") && (matches(pattern.slice(1)) || matches(`${pattern.slice(1).replace(/\/$/, "")}/**`)));
}

async function workspaceDefinition(cwd: string): Promise<WorkspaceDefinition | null> {
  try {
    const content = await readFile(join(cwd, "pnpm-workspace.yaml"), "utf-8");
    const document = parseDocument(content);
    if (document.errors.length) throw new Error("Invalid YAML syntax.");
    const config = document.toJS() as { packages?: unknown } | null;
    // pnpm permits a workspace file containing only catalog/settings entries.
    if (config === null || typeof config !== "object" || Array.isArray(config)) throw new Error("Workspace configuration must be a YAML mapping.");
    const patterns = config.packages ?? [];
    validateWorkspacePatterns(patterns);
    return { type: "pnpm-workspaces", patterns };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw createSetuprError({ code: "MALFORMED_PROJECT_FILE", cwd, details: ["File: pnpm-workspace.yaml", error instanceof Error ? error.message : String(error)] });
    }
  }

  const pkg = await readProjectJsonFile(cwd, "package.json");
  const workspaces = pkg?.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces as string[] : (workspaces as { packages?: string[] } | undefined)?.packages;
  if (await exists(cwd, "turbo.json")) return { type: "turborepo", patterns: patterns ?? ["packages/*", "apps/*"] };
  if (patterns) return { type: "npm-workspaces", patterns };
  const lerna = await readProjectJsonFile(cwd, "lerna.json");
  if (lerna) return { type: "lerna", patterns: (lerna.packages as string[] | undefined) ?? ["packages/*"] };
  if (await exists(cwd, "nx.json")) return { type: "nx", patterns: ["packages/*", "apps/*", "libs/*"] };
  return null;
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function resolveWorkspacePackages(cwd: string, patterns: string[]): Promise<string[]> {
  validateWorkspacePatterns(patterns);
  const included = patterns.filter((pattern) => !pattern.startsWith("!"));
  const excluded = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1).replace(/\/$/, ""));
  const matches = await glob(included.map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`), {
    cwd, nodir: true, dot: false, follow: false,
    ignore: ["**/node_modules/**", "**/.git/**", ...excluded.map((pattern) => `${pattern}/**`)],
  });
  const root = await realpath(cwd);
  const packages = new Set<string>();
  for (const match of matches.sort()) {
    const path = match.replace(/\/package\.json$/, "");
    const resolved = await realpath(join(cwd, path));
    const manifest = await realpath(join(cwd, match));
    if (!inside(root, resolved) || !inside(root, manifest)) {
      throw createSetuprError({ code: "MALFORMED_PROJECT_FILE", cwd, details: [`Workspace path escapes the project: ${path}`, "Remove the external symlink or correct the workspace patterns."] });
    }
    if (resolved !== root) packages.add(path.replace(/^\.\//, ""));
  }
  return [...packages].sort();
}

async function exists(cwd: string, file: string): Promise<boolean> {
  try { return (await stat(join(cwd, file))).isFile(); } catch { return false; }
}
