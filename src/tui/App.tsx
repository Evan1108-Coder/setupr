import React, { useEffect } from "react";
import { SetupLayout } from "./layouts/SetupLayout.js";
import { DoctorLayout } from "./layouts/DoctorLayout.js";
import { StartLayout } from "./layouts/StartLayout.js";
import { UpdateLayout } from "./layouts/UpdateLayout.js";
import { CleanLayout } from "./layouts/CleanLayout.js";
import { AuthLayout } from "./layouts/AuthLayout.js";
import { DashboardLayout } from "./layouts/DashboardLayout.js";
import { ChatLayout } from "./layouts/ChatLayout.js";
import { EnvLayout } from "./layouts/EnvLayout.js";
import type { DashboardStatus } from "../status/collector.js";
import type { ScanResult } from "../scanner/index.js";
import { scanProject } from "../scanner/index.js";
import { collectContext } from "../context/collector.js";
import { planSteps, shouldUseAIPlanner } from "../ai/planner.js";
import { executeAllSteps } from "../executor/index.js";
import { hasProjectSignals } from "./projectSignals.js";
import { getProviderEnvValue } from "../ai/models.js";
import { fromUnknownError, errorSummary } from "../errors/index.js";
import { parseEnvKeys, parseEnvPairs } from "../env/index.js";
import { deleteCheckpoint, formatCheckpointAge, loadCheckpoint } from "../state/checkpoint.js";
import { loadAgentWorkflowCheckpoint, saveAgentWorkflowCheckpoint } from "../agent/workflowCheckpoint.js";
import { analyzeEnvTemplate, createPostSetupSummary, formatEnvInsights } from "../agent/runtime.js";
import { applyPluginPlanners } from "../plugins/runtime.js";
import type { AgentPrompt, AgentPromptResponse, AppStore } from "../state/store.js";
import {
  applyPlanTextAdjustment,
  createConfirmationSummary,
  envInterpretationToRecord,
  formatConfirmationSummary,
  formatPlanningMessage,
  interpretEnvBatch,
  maskEnvVars,
  mergeEnvValues,
} from "../ai/setupFlow.js";

export type TUICommand = "dashboard" | "setup" | "start" | "doctor" | "update" | "clean" | "auth" | "status" | "chat" | "env";

interface AppProps {
  command: TUICommand;
  cwd: string;
  store: AppStore;
  cleanMode?: "deps" | "share" | "all";
  force?: boolean;
  dashboardStatus?: DashboardStatus;
  chatInitialMessage?: string;
  chatStartNew?: boolean;
  chatResume?: boolean;
}

export function App({ command, cwd, store, cleanMode = "deps", force = false, dashboardStatus, chatInitialMessage, chatStartNew = false, chatResume = false }: AppProps) {
  useEffect(() => {
    if (command === "setup") {
      runSetupFlow(cwd, store, { force });
    }
  }, []);

  const scan = store.getState().scan;

  switch (command) {
    case "setup":
      return <SetupLayout store={store} />;
    case "dashboard":
    case "status":
      return <DashboardLayout cwd={cwd} initialStatus={dashboardStatus} variant={command === "status" ? "status" : "dashboard"} />;
    case "doctor":
      return scan ? <DoctorLayout scan={scan} cwd={cwd} /> : <SetupLayout store={store} />;
    case "start":
      return scan ? <StartLayout scan={scan} cwd={cwd} /> : <SetupLayout store={store} />;
    case "update":
      return scan ? <UpdateLayout scan={scan} cwd={cwd} /> : <SetupLayout store={store} />;
    case "clean":
      return scan ? <CleanLayout scan={scan} cwd={cwd} mode={cleanMode} force={force} /> : <SetupLayout store={store} />;
    case "auth":
      return <AuthLayout />;
    case "chat":
      return <ChatLayout cwd={cwd} store={store} initialMessage={chatInitialMessage} startNew={chatStartNew} resume={chatResume} />;
    case "env":
      return <EnvLayout cwd={cwd} />;
    default:
      return <SetupLayout store={store} />;
  }
}

async function runSetupFlow(cwd: string, store: AppStore, options: { force: boolean }) {
  try {
    if (options.force) {
      await deleteCheckpoint(cwd);
    }
    const agentCheckpoint = options.force ? null : await loadAgentWorkflowCheckpoint(cwd);
    if (agentCheckpoint && agentCheckpoint.phase !== "complete") {
      store.getState().addLog({ content: `Found agent workflow checkpoint (${agentCheckpoint.phase}).`, type: "warning" });
      store.getState().addMessage({
        role: "assistant",
        content: `I found an interrupted agent workflow from ${formatCheckpointAge(agentCheckpoint.timestamp)}. I will restore the saved plan and continue from the recorded state.`,
      });
      store.getState().setSteps(agentCheckpoint.steps);
    }
    const checkpoint = options.force ? null : await loadCheckpoint(cwd);
    if (checkpoint) {
      const age = formatCheckpointAge(checkpoint.timestamp);
      const completed = checkpoint.completedSteps.length;
      const total = checkpoint.steps.length;
      store.getState().addLog({ content: `Found checkpoint from ${age} (${completed}/${total} steps done)`, type: "warning" });
      store.getState().addMessage({
        role: "assistant",
        content: `Resuming interrupted setup (${completed}/${total} steps completed ${age}). Picking up where we left off.`,
        level: "pattern",
        cost: 0,
      });
      store.getState().setScan(checkpoint.scan);
      store.getState().setSteps(checkpoint.steps);
      await populateKeyDeps(cwd, store);
      await populateEnvVars(cwd, store);
      populatePorts(store, checkpoint.scan);
      populateServices(store, checkpoint.scan);
      const context = await collectContext(cwd, checkpoint.scan);
      store.getState().setContext(context);

      store.getState().addLog({ content: "Resuming execution...", type: "info" });
      store.getState().setRunning(true);
      const execution = await executeAllSteps(checkpoint.steps, cwd, store, checkpoint.currentStepIndex);
      store.getState().setRunning(false);

      if (!execution.success) {
        store.getState().addLog({ content: "Setup stopped because a step failed.", type: "error" });
        store.getState().addMessage({
          role: "assistant",
          content: "Setup stopped because a step failed. Review the failed step above before continuing.",
        });
        return;
      }

      await deleteCheckpoint(cwd);
      await finishSuccessfulSetup(cwd, store);
      return;
    }

    store.getState().addLog({ content: "Scanning project structure...", type: "info" });
    store.getState().addMessage({ role: "system", content: "Scanning project..." });

    const scan = await scanProject(cwd);
    store.getState().setScan(scan);

    const stackParts = [scan.framework, scan.language, ...(scan.services || [])].filter(Boolean);
    if (!hasProjectSignals(scan)) {
      store.getState().addNotice({
        type: "warning",
        message: "No project files were detected in this directory. Open a project folder, then run setup again.",
      });
      store.getState().addLog({
        content: "No package, runtime, framework, dependency, or config files were detected.",
        type: "warning",
      });
      store.getState().addMessage({
        role: "assistant",
        content: "I did not find project files in this directory. Move into a project folder before running setup.",
      });
      store.getState().setComplete(true);
      return;
    }

    store.getState().addLog({ content: `Detected: ${stackParts.join(" + ")}`, type: "success" });
    store.getState().addLog({ content: `Found: ${scan.configFiles.join(", ")}`, type: "info" });
    store.getState().addMessage({
      role: "assistant",
      content: `Detected: ${scan.language || "unknown"}${scan.framework ? ` / ${scan.framework}` : ""} with ${scan.packageManager || "no"} package manager.`,
      level: "pattern",
      cost: 0,
    });

    await populateKeyDeps(cwd, store);
    await populateEnvVars(cwd, store);
    populatePorts(store, scan);
    populateServices(store, scan);

    const context = await collectContext(cwd, scan);
    store.getState().setContext(context);
    const envInsights = analyzeEnvTemplate(context);
    if (envInsights.length > 0) {
      store.getState().addMessage({
        role: "thinking",
        content: `Environment analysis:\n${formatEnvInsights(envInsights)}`,
      });
    }

    store.getState().addLog({ content: "Planning setup steps...", type: "info" });
    store.getState().addMessage({ role: "thinking", content: "Planning setup steps..." });
    let steps = agentCheckpoint?.steps?.length ? agentCheckpoint.steps : await planSteps(scan, context);
    if (!agentCheckpoint?.steps?.length) {
      const pluginPlanners = await applyPluginPlanners({
        cwd,
        scan,
        projectContext: context,
        steps,
        log: (message) => store.getState().addLog({ content: `Plugin: ${message}`, type: "info" }),
      });
      steps = pluginPlanners.steps;
      for (const diagnostic of pluginPlanners.diagnostics.filter((item) => item.status === "failed")) {
        store.getState().addNotice({ type: "warning", message: `Plugin ${diagnostic.name}: ${diagnostic.message}` });
      }
      const applied = pluginPlanners.diagnostics.filter((item) => item.message === "Planner applied.");
      if (applied.length) {
        store.getState().addMessage({
          role: "thinking",
          content: `Applied plugin planners: ${applied.map((item) => item.name).join(", ")}.`,
        });
      }
    }
    const planLevel = shouldUseAIPlanner(scan) && hasAIKeyCheck() ? "live" : "pattern";
    store.getState().setSteps(steps);
    await saveAgentWorkflowCheckpoint(cwd, {
      cwd,
      command: "setup",
      phase: "planning",
      steps,
      completedStepIds: [],
      failedStepIds: [],
      skippedStepIds: [],
      userAnswers: [],
      lastDecision: "Initial setup plan created.",
      safeOutputs: [],
    }).catch(() => undefined);
    store.getState().addLog({ content: `Plan ready: ${steps.length} steps to execute.`, type: "success" });
    store.getState().addMessage({
      role: "thinking",
      content: formatPlanningMessage(scan, steps, options.force),
      level: planLevel,
      cost: 0,
    });
    store.getState().addMessage({
      role: "assistant",
      content: `Plan ready: ${steps.length} steps to execute.`,
      level: planLevel,
      cost: 0,
    });

    const pendingEnvValues = await collectInteractiveInputs(cwd, scan, store, options.force);
    if (store.getState().isComplete) return;
    if (pendingEnvValues && Object.keys(pendingEnvValues).length > 0) {
      await mergeEnvValues(cwd, pendingEnvValues);
      store.getState().addLog({
        content: `Applied ${Object.keys(pendingEnvValues).length} confirmed environment value${Object.keys(pendingEnvValues).length === 1 ? "" : "s"} to .env.`,
        type: "success",
      });
    }
    const executableSteps = store.getState().steps;

    store.getState().addLog({ content: "Beginning execution...", type: "info" });
    store.getState().setRunning(true);
    const execution = await executeAllSteps(executableSteps, cwd, store);
    store.getState().setRunning(false);
    store.getState().setCheckpoint(true);

    if (!execution.success) {
      store.getState().addLog({ content: "Setup stopped because a step failed.", type: "error" });
      store.getState().addMessage({
        role: "assistant",
        content: "Setup stopped because a step failed. Review the failed step above before continuing.",
      });
      return;
    }

    await deleteCheckpoint(cwd);
    await finishSuccessfulSetup(cwd, store, execution.results);
  } catch (err) {
    const setuprError = fromUnknownError(err, { command: "setup", cwd });
    store.getState().addLog({ content: errorSummary(setuprError), type: "error" });
    store.getState().addNotice({ type: "error", message: setuprError.title });
    store.getState().addMessage({ role: "system", content: errorSummary(setuprError) });
    store.getState().setRunning(false);
  }
}

async function collectInteractiveInputs(
  cwd: string,
  scan: ScanResult,
  store: AppStore,
  force: boolean
): Promise<Record<string, string> | null> {
  const envVars = store.getState().envVars;
  const pending = envVars.filter((v) => v.status === "pending");

  if (force) {
    store.getState().addNotice({
      type: "info",
      message: "Force mode is using safe defaults and will stop only for blockers.",
    });
    if (pending.length > 0) {
      store.getState().addMessage({
        role: "thinking",
        content: `Force mode will not invent ${pending.length} missing environment value${pending.length === 1 ? "" : "s"}; .env can be created with blanks from the template.`,
      });
    }
    return null;
  }

  let pendingEnvValues: Record<string, string> | null = null;

  if (pending.length > 0) {
    const response = await askPrompt(store, {
      id: "env-batch",
      type: "choice",
      title: "Environment Values",
      message: [
        `I found ${pending.length} missing value${pending.length === 1 ? "" : "s"} from .env.example:`,
        pending.map((v) => v.key).join(", "),
        "Paste KEY=value lines in Other if you already have them, or continue with blanks/defaults.",
      ].join("\n"),
      options: [
        { id: "continue-env", label: "Continue with blanks", description: "Create/update .env from the template" },
        { id: "skip-env", label: "Skip env setup", description: "Leave .env untouched" },
      ],
      includeOther: true,
      otherLabel: "Paste values...",
      placeholder: "OPENAI_API_KEY=...\nDATABASE_URL=...",
      createdAt: Date.now(),
    });

    if (response.optionId === "skip-env") {
      skipEnvStep(store, "Skipped environment setup because you asked me to leave it untouched.");
    } else if (!response.optionId && response.value.trim()) {
      const parsed = interpretEnvBatch(response.value);
      const values = envInterpretationToRecord(parsed);
      if (Object.keys(values).length > 0) {
        pendingEnvValues = values;
        store.getState().setEnvVars(
          store.getState().envVars.map((env) =>
            values[env.key] !== undefined
              ? { ...env, value: values[env.key], status: "filled" as const, source: "pending confirmation" }
              : env
          )
        );
        store.getState().addLog({
          content: `Recorded ${Object.keys(values).length} pasted environment value${Object.keys(values).length === 1 ? "" : "s"} for confirmation.`,
          type: "success",
        });
        store.getState().addMessage({
          role: "thinking",
          content: `Parsed environment paste: ${maskEnvVars(Object.entries(values).map(([key, value]) => ({ key, value }))).map((item) => `${item.key}=${item.value}`).join(", ")}.`,
        });
      }
      if (parsed.ignored.some((line) => line.reason !== "blank" && line.reason !== "comment")) {
        store.getState().addNotice({
          type: "warning",
          message: "Some pasted env lines were ignored because they were not KEY=value pairs.",
        });
      }
      if (parsed.duplicates.length > 0) {
        store.getState().addNotice({
          type: "info",
          message: `Duplicate env keys used the last pasted value: ${parsed.duplicates.join(", ")}.`,
        });
      }
    }
  }

  await confirmPlan(scan, store);
  if (store.getState().isComplete) return null;
  return pendingEnvValues;
}

async function finishSuccessfulSetup(cwd: string, store: AppStore, results: Awaited<ReturnType<typeof executeAllSteps>>["results"] = []): Promise<void> {
  await refreshEnvVars(cwd, store);
  store.getState().setComplete(true);

  const currentServices = store.getState().services;
  if (currentServices.length > 0) {
    store.getState().setServices(
      currentServices.map((s) => ({ ...s, status: "ready" as const }))
    );
  }

  try {
    const { access: accessCheck } = await import("fs/promises");
    const { join } = await import("path");
    const lockFiles = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"];
    for (const lf of lockFiles) {
      try {
        await accessCheck(join(cwd, lf));
        store.setState({ lockSynced: true });
        break;
      } catch {}
    }
  } catch {}

  store.getState().addLog({ content: "Setup complete!", type: "success" });
  const context = store.getState().context;
  if (context) {
    const summary = createPostSetupSummary({
      context,
      steps: store.getState().steps,
      results,
      envInsights: analyzeEnvTemplate(context),
    });
    store.getState().addMessage({ role: "assistant", content: summary });
  }
  store.getState().addMessage({
    role: "assistant",
    content: "Setup complete! You can now chat with me about your project.",
  });
}

async function confirmPlan(scan: ScanResult, store: AppStore): Promise<void> {
  const response = await askPrompt(store, createPlanPrompt(scan, store, "confirm-plan"));

  if (response.optionId === "cancel-plan" || /\b(cancel|stop|abort)\b/i.test(response.value)) {
    store.getState().addLog({ content: "Setup cancelled before execution.", type: "warning" });
    store.getState().addMessage({ role: "assistant", content: "Cancelled before execution. No setup steps were run." });
    store.getState().setSteps(store.getState().steps.map((step) => ({ ...step, status: "skipped" as const })));
    store.getState().setComplete(true);
    return;
  }

  if (!response.optionId && response.value.trim()) {
    const adjusted = applyPlanTextAdjustment(store.getState().steps, response.value);
    store.getState().setSteps(adjusted.steps);
    for (const note of adjusted.notes) {
      store.getState().addLog({ content: note, type: "info" });
      store.getState().addMessage({ role: "thinking", content: note });
    }

    const finalResponse = await askPrompt(store, createPlanPrompt(scan, store, "confirm-adjusted-plan"));
    if (finalResponse.optionId === "cancel-plan" || /\b(cancel|stop|abort)\b/i.test(finalResponse.value)) {
      store.getState().addLog({ content: "Setup cancelled after plan adjustment.", type: "warning" });
      store.getState().addMessage({ role: "assistant", content: "Cancelled after plan adjustment. No setup steps were run." });
      store.getState().setSteps(store.getState().steps.map((step) => ({ ...step, status: "skipped" as const })));
      store.getState().setComplete(true);
      return;
    }
  }

  store.getState().addMessage({ role: "assistant", content: "Confirmed. I will execute the plan now." });
}

function createPlanPrompt(scan: ScanResult, store: AppStore, id: string): AgentPrompt {
  const env = store.getState().envVars
    .filter((item) => item.value)
    .map((item) => ({ key: item.key, value: item.value }));
  const summary = createConfirmationSummary({ scan, steps: store.getState().steps, env });
  return {
    id,
    type: "confirm",
    title: id === "confirm-plan" ? "Confirm Setup Plan" : "Confirm Adjusted Plan",
    message: formatConfirmationSummary(summary),
    options: [
      { id: "proceed-plan", label: "Proceed", description: "Run these setup steps" },
      { id: "cancel-plan", label: "Cancel", description: "Exit without running setup" },
    ],
    includeOther: true,
    otherLabel: "Adjust plan...",
    placeholder: "Example: skip build, use pnpm, do not change env",
    createdAt: Date.now(),
  };
}

function askPrompt(store: AppStore, prompt: AgentPrompt): Promise<AgentPromptResponse> {
  store.getState().clearPromptResponse();
  store.getState().setPendingPrompt(prompt);
  store.getState().setActivePanel(0);
  store.getState().addMessage({
    role: "assistant",
    content: prompt.message ? `${prompt.title}\n${prompt.message}` : prompt.title,
  });

  return new Promise((resolve) => {
    const unsubscribe = store.subscribe((state, previous) => {
      const response = state.promptResponse;
      if (!response || previous.promptResponse === response || response.promptId !== prompt.id) return;
      unsubscribe();
      recordPromptAnswer(store, prompt, response);
      store.getState().clearPromptResponse();
      resolve(response);
    });
  });
}

function recordPromptAnswer(store: AppStore, prompt: AgentPrompt, response: AgentPromptResponse): void {
  const content = summarizePromptResponse(prompt, response);
  const sensitive = prompt.sensitive || /KEY|SECRET|TOKEN|PASSWORD/i.test(prompt.title);
  store.getState().addMessage({
    role: "user",
    content: sensitive ? "••••••••" : content,
  });
}

function summarizePromptResponse(prompt: AgentPrompt, response: AgentPromptResponse): string {
  if (prompt.id === "env-batch" && !response.optionId) {
    const parsed = interpretEnvBatch(response.value);
    const values = envInterpretationToRecord(parsed);
    const masked = maskEnvVars(Object.entries(values).map(([key, value]) => ({ key, value })));
    return masked.length > 0
      ? masked.map((item) => `${item.key}=${item.value}`).join(", ")
      : "Pasted environment values";
  }

  return response.value;
}

function skipEnvStep(store: AppStore, message: string): void {
  store.getState().setEnvVars(store.getState().envVars.map((env) =>
    env.status === "pending" ? { ...env, status: "skipped" as const } : env
  ));
  store.getState().setSteps(store.getState().steps.map((step) =>
    step.type === "env" ? { ...step, status: "skipped" as const } : step
  ));
  store.getState().addLog({ content: message, type: "info" });
}

async function populateKeyDeps(cwd: string, store: AppStore) {
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const important = Object.entries(allDeps).slice(0, 8).map(([name, version]) => ({
      name,
      version: String(version).replace(/[\^~]/, ""),
      status: "ok" as const,
    }));
    store.getState().setKeyDeps(important);
    const total = Object.keys(allDeps).length;
    store.getState().setPackageStats({ total, installed: total, deprecated: 0 });
  } catch {}
}

export async function populateEnvVars(cwd: string, store: AppStore) {
  try {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    const example = await readFile(join(cwd, ".env.example"), "utf-8");
    const requiredKeys = parseEnvKeys(example);

    let currentVars: Record<string, string> = {};
    try {
      const env = await readFile(join(cwd, ".env"), "utf-8");
      currentVars = parseEnvPairs(env);
    } catch {}

    const envVars = requiredKeys.map((key) => ({
      key,
      value: currentVars[key] || process.env[key] || "",
      status: (currentVars[key] ? "auto" : process.env[key] ? "auto" : "pending") as "auto" | "pending",
      source: currentVars[key] ? ".env" : process.env[key] ? "system" : undefined,
    }));

    store.getState().setEnvVars(envVars);
  } catch {}
}

async function refreshEnvVars(cwd: string, store: AppStore) {
  store.getState().setEnvVars([]);
  await populateEnvVars(cwd, store);
}

function populatePorts(store: AppStore, scan: ScanResult) {
  const ports: Array<{ service: string; port: number; status: "free" | "in_use" }> = [];
  if (scan.framework) {
    const defaultPorts: Record<string, number> = {
      "Next.js": 3000, "React": 3000, "Vue": 5173, "Svelte": 5173,
      "Angular": 4200, "Express": 3000, "Fastify": 3000, "Django": 8000,
      "Flask": 5000, "FastAPI": 8000, "Gin": 8080,
    };
    const port = defaultPorts[scan.framework];
    if (port) ports.push({ service: scan.framework, port, status: "free" });
  }
  for (const svc of scan.services) {
    const svcPorts: Record<string, number> = {
      "PostgreSQL": 5432, "MySQL": 3306, "Redis": 6379, "MongoDB": 27017,
      "Docker": 2375, "Elasticsearch": 9200,
    };
    const port = svcPorts[svc];
    if (port) ports.push({ service: svc, port, status: "free" });
  }
  store.getState().setPorts(ports);
}

function populateServices(store: AppStore, scan: ScanResult) {
  const services = scan.services.map((name) => ({
    name,
    status: "pending" as const,
    port: undefined,
  }));
  store.getState().setServices(services);
}

function hasAIKeyCheck(): boolean {
  return !!(
    getProviderEnvValue("minimax") ||
    getProviderEnvValue("moonshot") ||
    getProviderEnvValue("openai") ||
    getProviderEnvValue("groq") ||
    getProviderEnvValue("anthropic") ||
    getProviderEnvValue("google") ||
    getProviderEnvValue("github")
  );
}
