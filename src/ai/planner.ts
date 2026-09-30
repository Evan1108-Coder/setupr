import { chat, hasAIKey, type ChatMessage } from "./client.js";
import type { ScanResult } from "../scanner/index.js";
import { scanResultToDSL, type ProjectContext } from "./dsl.js";

export interface SetupStep {
  id: string;
  label: string;
  type: "runtime" | "deps" | "env" | "script" | "verify" | "config";
  command?: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  output?: string;
  error?: string;
}

export async function planSteps(scan: ScanResult, context?: ProjectContext): Promise<SetupStep[]> {
  if (hasAIKey() && shouldUseAIPlanner(scan)) {
    try {
      return await planStepsWithAI(scan, context);
    } catch {
      // fallback to heuristic
    }
  }
  return planStepsHeuristic(scan, context);
}

export function shouldUseAIPlanner(scan: ScanResult): boolean {
  if (!scan.language && !scan.framework && !scan.packageManager && scan.configFiles.length > 0) {
    return true;
  }

  if (scan.configFiles.some((file) => file === ".setupr.json")) {
    return false;
  }

  const knownSignals = [
    scan.language,
    scan.framework,
    scan.packageManager,
    scan.runtime?.name,
    scan.monorepo?.type,
  ].filter(Boolean);

  return knownSignals.length === 0 && scan.configFiles.length > 0;
}

async function planStepsWithAI(scan: ScanResult, context?: ProjectContext): Promise<SetupStep[]> {
  const dsl = scanResultToDSL(scan);
  const contextBlock = context ? planningContextPrompt(context).slice(0, 6000) : "No document context loaded.";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are Setupr's step planner. Given a project profile, produce a setup plan.
Respond ONLY with a JSON array of steps. Each step: {"id":"unique_id","label":"Human label","type":"runtime|deps|env|script|verify|config","command":"shell command or null"}
Be practical and specific to the detected stack.`,
    },
    {
      role: "user",
      content: `Plan setup steps for: ${dsl}\nScripts available: ${Object.keys(scan.scripts).join(", ") || "none"}\nServices: ${scan.services.join(", ") || "none"}\n\nProject context:\n${contextBlock}`,
    },
  ];

  const result = await chat(messages, { temperature: 0.1, maxTokens: 1200, timeoutMs: 8000, maxRetries: 0 });

  try {
    const jsonMatch = result.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("No JSON array found");
    const steps = JSON.parse(jsonMatch[0]);
    return steps.map((s: any) => ({
      id: s.id || crypto.randomUUID().slice(0, 8),
      label: s.label,
      type: s.type || "script",
      command: s.command || undefined,
      status: "pending" as const,
    }));
  } catch {
    return planStepsHeuristic(scan);
  }
}

export function planStepsHeuristic(scan: ScanResult, context?: ProjectContext): SetupStep[] {
  const steps: SetupStep[] = [];

  // Runtime check/install
  if (scan.runtime) {
    steps.push({
      id: "runtime",
      label: `Check ${scan.runtime.name}${scan.runtime.version ? ` ${scan.runtime.version}` : ""} runtime`,
      type: "runtime",
      command: getVersionCheckCommand(scan.runtime.name),
      status: "pending",
    });
  }

  // Install dependencies
  if (scan.packageManager) {
    const installCmd = getInstallCommand(scan.packageManager, scan.configFiles);
    steps.push({
      id: "deps",
      label: `Install dependencies (${scan.packageManager})`,
      type: "deps",
      command: installCmd,
      status: "pending",
    });
  }

  // Environment setup
  if (scan.configFiles.includes(".env.example")) {
    steps.push({
      id: "env",
      label: "Configure environment variables",
      type: "env",
      status: "pending",
    });
  }

  // Services check
  if (scan.services.length > 0) {
    steps.push({
      id: "services",
      label: `Verify services: ${scan.services.join(", ")}`,
      type: "verify",
      status: "pending",
    });
  }

  if (context?.setupHints?.some((hint) => /migration/i.test(hint))) {
    const migrationScript = Object.keys(scan.scripts).find((name) => /migrate|db/.test(name));
    if (migrationScript) {
      steps.push({
        id: "migrations",
        label: "Run documented database migration step",
        type: "script",
        command: `${scan.packageManager || "npm"} run ${migrationScript}`,
        status: "pending",
      });
    } else {
      steps.push({
        id: "migrations-note",
        label: "Review documented database migration step",
        type: "verify",
        status: "pending",
      });
    }
  }

  // Post-install scripts
  if (scan.scripts.postinstall || scan.scripts.prepare) {
    steps.push({
      id: "postinstall",
      label: "Run post-install scripts",
      type: "script",
      command: scan.scripts.postinstall
        ? `${scan.packageManager || "npm"} run postinstall`
        : `${scan.packageManager || "npm"} run prepare`,
      status: "pending",
    });
  }

  // Build step (if applicable)
  if (scan.scripts.build) {
    steps.push({
      id: "build",
      label: "Run build",
      type: "script",
      command: `${scan.packageManager || "npm"} run build`,
      status: "pending",
    });
  }

  // Verify
  steps.push({
    id: "verify",
    label: "Verify setup",
    type: "verify",
    status: "pending",
  });

  return steps;
}

function getInstallCommand(pm: string, configFiles: string[]): string {
  const cmds: Record<string, string> = {
    npm: "npm install",
    yarn: "yarn install",
    pnpm: "pnpm install",
    bun: "bun install",
    pip: configFiles.includes("pyproject.toml") && !configFiles.includes("requirements.txt")
      ? "pip install ."
      : "pip install -r requirements.txt",
    pipenv: "pipenv install",
    poetry: "poetry install",
    cargo: "cargo build",
    go: "go mod download",
    bundler: "bundle install",
    composer: "composer install",
    pub: "dart pub get",
    mix: "mix deps.get",
  };
  return cmds[pm] || `${pm} install`;
}

function getVersionCheckCommand(runtime: string): string {
  const cmds: Record<string, string> = {
    node: "node --version",
    python: "python3 --version",
    ruby: "ruby --version",
    go: "go version",
    rust: "rustc --version",
    java: "java --version",
  };
  return cmds[runtime] || `${runtime} --version`;
}

function planningContextPrompt(context: ProjectContext): string {
  const docs = context.documents
    ?.slice(0, 6)
    .map((doc) => `${doc.path}: ${doc.excerpt.slice(0, 900)}`)
    .join("\n\n") || "No setup documents.";
  const scripts = context.packageScripts
    ?.slice(0, 10)
    .map((script) => `${script.name}: ${script.command}`)
    .join("\n") || "No scripts.";
  return [
    `Scripts:\n${scripts}`,
    `Env missing: ${context.envVars.missing.join(", ") || "none"}`,
    `Hints: ${context.setupHints?.join("; ") || "none"}`,
    `Docs:\n${docs}`,
  ].join("\n\n");
}
