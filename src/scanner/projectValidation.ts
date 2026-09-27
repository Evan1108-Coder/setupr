import { readFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { createSetuprError } from "../errors/index.js";

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateWorkspacePatterns(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error("Workspace packages must be an array of non-empty glob strings.");
  }
  for (const entry of value) {
    const pattern = entry.replace(/^!/, "");
    if (!pattern || isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.includes("\\")
      || pattern.split("/").includes("..") || [...pattern].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
      throw new Error("Workspace patterns must be relative paths inside the project; parent paths are not allowed.");
    }
  }
}

function validateConfig(config: unknown): void {
  if (!record(config)) throw new Error("Setupr configuration must be a JSON object.");
  for (const field of ["language", "framework", "packageManager"]) {
    if (config[field] !== undefined && (typeof config[field] !== "string" || !config[field].trim())) {
      throw new Error(`Setupr ${field} must be a non-empty string.`);
    }
  }
  if (config.packageManager !== undefined && !["npm", "yarn", "pnpm", "bun", "deno", "pip", "pipenv", "poetry", "uv", "cargo", "go", "bundler", "composer", "pub", "mix"].includes(String(config.packageManager))) {
    throw new Error("Setupr packageManager must name a supported package manager.");
  }
  if (config.runtime !== undefined) {
    const runtime = config.runtime;
    if (typeof runtime === "string" && runtime.trim()) return;
    if (!record(runtime) || typeof runtime.name !== "string" || !runtime.name.trim()
      || (runtime.version !== undefined && runtime.version !== null && typeof runtime.version !== "string")) {
      throw new Error("Setupr runtime must be a name or an object with a name and optional string version.");
    }
  }
}

export function validateProjectJson(file: string, value: unknown): void {
  if (!record(value)) throw new Error(`${file} must contain a JSON object.`);
  if (file === ".setupr.json") return validateConfig(value);
  if (file === "lerna.json") {
    if (value.packages !== undefined) validateWorkspacePatterns(value.packages);
    return;
  }
  if (file !== "package.json") return;
  for (const field of ["name", "version", "packageManager"]) {
    if (value[field] !== undefined && typeof value[field] !== "string") throw new Error(`package.json ${field} must be a string.`);
  }
  for (const field of ["scripts", "dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "engines"]) {
    if (value[field] !== undefined && (!record(value[field]) || Object.values(value[field]).some((item) => typeof item !== "string"))) {
      throw new Error(`package.json ${field} must be an object of string values.`);
    }
  }
  if (value.workspaces !== undefined) validateWorkspacePatterns(record(value.workspaces) ? value.workspaces.packages : value.workspaces);
  if (value.setupr !== undefined) validateConfig(value.setupr);
}

export async function readProjectJsonFile(cwd: string, file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(cwd, file), "utf-8");
    const value: unknown = JSON.parse(raw);
    validateProjectJson(file, value);
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw createSetuprError({
      code: file === ".setupr.json" ? "PROJECT_CONFIG_INVALID" : "MALFORMED_PROJECT_FILE",
      cwd,
      details: [`File: ${file}`, error instanceof SyntaxError ? "Invalid JSON syntax." : (error instanceof Error ? error.message : String(error))],
      canContinue: false,
    });
  }
}
