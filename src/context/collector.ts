import { execSync } from "child_process";
import { createHash } from "crypto";
import { existsSync } from "fs";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { ScanResult } from "../scanner/index.js";
import { type ProjectContext } from "../ai/dsl.js";
import { compressDocumentExcerpt } from "../ai/contextCompression.js";
import { parseEnvKeys, parseEnvPairs } from "../env/index.js";
import { readGitRemotes, selectGitRemote } from "../util/gitRemote.js";

export async function collectContext(cwd: string, scan: ScanResult): Promise<ProjectContext> {
  const cached = await readCachedContext(cwd, scan);
  if (cached) {
    const [git, envVars, fileTree, terminal] = await Promise.all([
      collectGitInfo(cwd), collectEnvVars(cwd), collectFileTree(cwd), collectTerminalInfo(),
    ]);
    return { ...cached, scan, git, envVars, fileTree, terminal, collectedAt: Date.now() };
  }

  const [git, envVars, fileTree, terminal, documents] = await Promise.all([
    collectGitInfo(cwd),
    collectEnvVars(cwd),
    collectFileTree(cwd),
    collectTerminalInfo(),
    collectDocuments(cwd),
  ]);

  const context: ProjectContext = {
    cwd,
    scan,
    git,
    envVars,
    fileTree,
    terminal,
    documents,
    packageScripts: rankPackageScripts(scan.scripts),
    setupHints: extractSetupHints(documents, scan),
    docker: {
      files: fileTree.filter((file) => /^Dockerfile(?:\.|$)/.test(file)),
      composeFiles: fileTree.filter((file) => /(?:^|\/)docker-compose\.(ya?ml)$|(?:^|\/)compose\.(ya?ml)$/.test(file)),
    },
    ci: {
      files: fileTree.filter((file) => /^\.github\/workflows\/|^\.gitlab-ci\.yml$|^circle\.yml$|^bitbucket-pipelines\.yml$/.test(file)),
    },
    collectedAt: Date.now(),
    cacheHit: false,
  };
  await writeCachedContext(cwd, scan, context).catch(() => undefined);
  return context;
}

async function collectGitInfo(cwd: string): Promise<ProjectContext["git"]> {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
  } catch {
    return { isRepo: false };
  }

  try {
    const branch = execSync("git branch --show-current", { cwd, stdio: "pipe" })
      .toString()
      .trim();
    const remoteUrl = selectGitRemote(await readGitRemotes(cwd))?.url;
    const isDirty =
      execSync("git status --porcelain", { cwd, stdio: "pipe" })
        .toString()
        .trim().length > 0;
    return { isRepo: true, branch, remoteUrl, isDirty };
  } catch {
    return { isRepo: true };
  }
}

async function collectEnvVars(cwd: string): Promise<ProjectContext["envVars"]> {
  const defined: string[] = [];
  const missing: string[] = [];
  const templateKeys: string[] = [];

  try {
    const example = await readFile(join(cwd, ".env.example"), "utf-8");
    const requiredVars = parseEnvKeys(example);
    templateKeys.push(...requiredVars);

    let currentVars: Record<string, string> = Object.create(null);
    try {
      const env = await readFile(join(cwd, ".env"), "utf-8");
      currentVars = parseEnvPairs(env);
    } catch {}

    for (const v of requiredVars) {
      if (currentVars[v]?.trim() || process.env[v]?.trim()) {
        defined.push(v);
      } else {
        missing.push(v);
      }
    }
  } catch {}

  return { defined, missing, templateKeys };
}

async function collectFileTree(cwd: string): Promise<string[]> {
  const files: string[] = [];
  const ignore = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", "venv", ".venv", "target"]);

  async function walk(dir: string, prefix: string, depth: number) {
    if (depth > 3) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.slice(0, 200)) {
        if (ignore.has(entry.name)) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        files.push(path);
        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), path, depth + 1);
        }
      }
    } catch {}
  }

  await walk(cwd, "", 0);
  return files.slice(0, 200);
}

function collectTerminalInfo(): ProjectContext["terminal"] {
  return {
    shell: process.env.SHELL || "unknown",
    term: process.env.TERM || "unknown",
    columns: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
    platform: process.platform,
    nodeVersion: process.version,
  };
}

async function collectDocuments(cwd: string): Promise<NonNullable<ProjectContext["documents"]>> {
  const candidates = [
    { path: "README.md", kind: "readme" as const },
    { path: "README", kind: "readme" as const },
    { path: "SETUP.md", kind: "setup" as const },
    { path: "CONTRIBUTING.md", kind: "contributing" as const },
    { path: ".env.example", kind: "env" as const },
    { path: "Dockerfile", kind: "docker" as const },
    { path: "docker-compose.yml", kind: "docker" as const },
    { path: "compose.yml", kind: "docker" as const },
    { path: ".github/workflows/ci.yml", kind: "ci" as const },
    { path: ".github/workflows/ci.yaml", kind: "ci" as const },
    { path: ".gitlab-ci.yml", kind: "ci" as const },
    { path: ".setupr.json", kind: "config" as const },
  ];

  const docs: NonNullable<ProjectContext["documents"]> = [];
  for (const candidate of candidates) {
    const path = join(cwd, candidate.path);
    if (!existsSync(path)) continue;
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 512_000) continue;
      const content = await readFile(path, "utf-8");
      const excerpt = excerptDocument(content);
      docs.push({ path: candidate.path, kind: candidate.kind, excerpt, compact: compressDocumentExcerpt(candidate.path, candidate.kind, excerpt) });
    } catch {}
  }

  const docDirs = ["docs", ".github"];
  for (const dir of docDirs) {
    try {
      const entries = await readdir(join(cwd, dir), { withFileTypes: true });
      for (const entry of entries.slice(0, 20)) {
        if (!entry.isFile() || !/\.(md|mdx|txt|ya?ml)$/i.test(entry.name)) continue;
        const rel = `${dir}/${entry.name}`;
        const info = await stat(join(cwd, rel));
        if (!info.isFile() || info.size > 512_000) continue;
        const content = await readFile(join(cwd, rel), "utf-8").catch(() => "");
        if (content) {
          const kind = dir === "docs" ? "docs" : "ci";
          const excerpt = excerptDocument(content);
          docs.push({ path: rel, kind, excerpt, compact: compressDocumentExcerpt(rel, kind, excerpt) });
        }
      }
    } catch {}
  }

  return docs.slice(0, 20);
}

function rankPackageScripts(scripts: Record<string, string>): NonNullable<ProjectContext["packageScripts"]> {
  const weights: Record<string, { score: number; reason: string }> = {
    dev: { score: 100, reason: "common local development script" },
    start: { score: 90, reason: "standard app start script" },
    serve: { score: 85, reason: "common preview/server script" },
    develop: { score: 80, reason: "framework development script" },
    watch: { score: 70, reason: "watch mode script" },
    test: { score: 55, reason: "verification script" },
    build: { score: 50, reason: "build verification script" },
  };
  return Object.entries(scripts)
    .map(([name, command]) => ({
      name,
      command,
      score: weights[name]?.score ?? (/(dev|start|serve|watch)/i.test(name) ? 65 : 20),
      reason: weights[name]?.reason ?? "project script",
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function extractSetupHints(
  documents: NonNullable<ProjectContext["documents"]>,
  scan: ScanResult
): string[] {
  const hints = new Set<string>();
  for (const doc of documents) {
    const lower = doc.excerpt.toLowerCase();
    if (/npm install|pnpm install|yarn install|bun install/.test(lower)) hints.add("docs mention dependency installation");
    if (/copy .*\.env|\.env\.example|environment variable/.test(lower)) hints.add("docs mention environment configuration");
    if (/docker compose|docker-compose/.test(lower)) hints.add("docs mention Docker Compose");
    if (/migrate|migration|prisma|alembic|manage\.py migrate/.test(lower)) hints.add("docs mention database migrations");
    if (/postgres|redis|mysql|mongodb/.test(lower)) hints.add("docs mention backing services");
  }
  if (scan.services.length) hints.add(`scanner detected services: ${scan.services.join(", ")}`);
  return [...hints].slice(0, 12);
}

function excerptDocument(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !line.trim().startsWith("!["))
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .slice(0, 5000);
}

async function readCachedContext(cwd: string, scan: ScanResult): Promise<ProjectContext | null> {
  try {
    const cacheFile = cachePath(cwd);
    const raw = await readFile(cacheFile, "utf-8");
    const parsed = JSON.parse(raw) as { key?: string; context?: ProjectContext };
    if (parsed.key !== await cacheKey(cwd, scan) || !parsed.context) return null;
    return { ...parsed.context, cacheHit: true };
  } catch {
    return null;
  }
}

async function writeCachedContext(cwd: string, scan: ScanResult, context: ProjectContext): Promise<void> {
  const file = cachePath(cwd);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ key: await cacheKey(cwd, scan), context }, null, 2)}\n`, "utf-8");
}

function cachePath(cwd: string): string {
  return join(cwd, ".setupr", "cache", "project-context.json");
}

async function cacheKey(cwd: string, scan: ScanResult): Promise<string> {
  const files = [
    "package.json",
    "README.md",
    "README",
    "SETUP.md",
    "CONTRIBUTING.md",
    ".env.example",
    "Dockerfile",
    "docker-compose.yml",
    "compose.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/ci.yaml",
    ".gitlab-ci.yml",
    ".setupr.json",
  ];
  for (const dir of ["docs", ".github"]) {
    try {
      const entries = await readdir(join(cwd, dir), { withFileTypes: true });
      for (const entry of entries.slice(0, 20)) {
        if (entry.isFile() && /\.(md|mdx|txt|ya?ml)$/i.test(entry.name)) files.push(`${dir}/${entry.name}`);
      }
    } catch {}
  }
  const hash = createHash("sha256");
  hash.update("context-v2");
  hash.update(JSON.stringify(scan));
  for (const file of files) {
    try {
      const info = await stat(join(cwd, file));
      hash.update(`${file}:${info.mtimeMs}:${info.size}`);
    } catch {}
  }
  return hash.digest("hex");
}
