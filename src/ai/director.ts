import type { ScanResult } from "../scanner/index.js";
import type { AppStore } from "../state/store.js";
import { updateConfig } from "../state/config.js";
import {
  MODELS,
  PROVIDERS,
  describeDefaultModelSelection,
  estimateModelWeightedCost,
  formatModelPrice,
  getAvailableModels,
  getProviderEnvValue,
  isModelAvailable,
  resolveModel,
  selectDefaultModel,
  type AIModel,
} from "./models.js";
import { buildDirectorContextPacket, sanitizeForAI } from "./directorContext.js";
import { intelligentResponse } from "./intelligence.js";
import { applySteeringToPlan, formatPlanChange, maskKeyValues } from "../agent/runtime.js";
import {
  envInterpretationToRecord,
  interpretEnvBatch,
  maskEnvVars,
  mergeEnvValues,
} from "./setupFlow.js";
import { intentToSteeringText, parseUserIntent, type ParsedUserIntent } from "./userIntent.js";

export interface DirectorInput {
  text: string;
  cwd: string;
  scan: ScanResult;
  contextDSL: string;
  store: AppStore;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface DirectorResult {
  handled: boolean;
  action: string;
}

export async function handleDirectorInput(input: DirectorInput): Promise<DirectorResult> {
  input.signal?.throwIfAborted();
  const text = input.text.trim();
  if (!text) return { handled: true, action: "empty" };
  const parsedIntent = parseUserIntent(text);

  const modelResult = await maybeHandleModelIntent(input, text);
  if (modelResult) return modelResult;

  const statusResult = maybeHandleStatusIntent(input, text);
  if (statusResult) return statusResult;

  const envResult = await maybeHandleEnvIntent(input, text);
  if (envResult) return envResult;

  const promptResult = maybeHandlePromptIntent(input, text);
  if (promptResult) return promptResult;

  const planResult = maybeHandlePlanIntent(input, text, parsedIntent);
  if (planResult) return planResult;

  const conversation = input.store.getState().messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-12);
  if (conversation.at(-1)?.role === "user" && conversation.at(-1)?.content === sanitizeForAI(text)) conversation.pop();
  const result = await intelligentResponse(text, input.scan, input.contextDSL, {
    parsedIntent,
    signal: input.signal,
    onProgress: input.onProgress,
    messages: conversation.map((message) => ({ role: message.role as "user" | "assistant", content: sanitizeForAI(message.content).slice(-4000) })),
    directorContext: buildDirectorContextPacket({ ...input, userText: text, parsedIntent }),
  });
  input.signal?.throwIfAborted();
  input.store.getState().addMessage({
    role: "assistant",
    content: result.response,
    level: result.level,
    cost: result.cost,
  });
  return { handled: true, action: "answer" };
}

async function maybeHandleModelIntent(input: DirectorInput, text: string): Promise<DirectorResult | null> {
  if (/\b(what|which|current).{0,24}\bmodel\b|\bmodel.{0,24}(using|active|current)\b/i.test(text)) {
    input.store.getState().addMessage({
      role: "assistant",
      content: `Current AI model: ${describeDefaultModelSelection()}.`,
    });
    return { handled: true, action: "model.status" };
  }

  if (/\b(use|switch|change|set).{0,24}\b(cheapest|lowest cost|least expensive)\b/i.test(text)) {
    const model = getCheapestAvailableModel();
    if (!model) {
      input.store.getState().addMessage({
        role: "assistant",
        content: "I cannot switch to the cheapest model yet because no configured provider has known pricing. Set a provider key or explicitly name a model.",
      });
      return { handled: true, action: "model.cheapest.unavailable" };
    }
    await switchModel(input.store, model, "I selected the cheapest configured model with known pricing.");
    return { handled: true, action: "model.cheapest" };
  }

  if (!hasModelIntentSignal(text)) return null;

  const requested = extractRequestedModel(text);
  if (!requested) {
    if (isAmbiguousModelChange(text)) return askWhichModelToChange(input);
    return null;
  }

  const model = findModelForRequest(requested);
  if (!model) {
    input.store.getState().addMessage({
      role: "assistant",
      content: `I do not recognize "${requested}" as an available model ID or name. Run setupr auth models to see the catalog, or use a GitHub Models ID like publisher/model-name.`,
    });
    return { handled: true, action: "model.unknown" };
  }

  if (!isModelAvailable(model)) {
    const provider = PROVIDERS[model.provider];
    const keys = [provider.envKey, ...(provider.envAliases || [])].join(" or ");
    input.store.getState().addMessage({
      role: "assistant",
      content: `I found ${model.id}, but ${model.provider} is not configured. Run setupr auth set-key ${model.provider}, or set ${keys} for this shell, then I can switch to it.`,
    });
    return { handled: true, action: "model.unavailable" };
  }

  await switchModel(input.store, model, "You asked me to change models, so I changed the active director model.");
  return { handled: true, action: "model.switch" };
}

function maybeHandleStatusIntent(input: DirectorInput, text: string): DirectorResult | null {
  if (!/\b(status|what are you doing|show plan|current plan|where are we)\b/i.test(text)) return null;
  const state = input.store.getState();
  const done = state.steps.filter((step) => step.status === "done").length;
  const skipped = state.steps.filter((step) => step.status === "skipped").length;
  const failed = state.steps.filter((step) => step.status === "failed").length;
  const running = state.steps.find((step) => step.status === "running");
  const pending = state.steps.filter((step) => step.status === "pending").length;
  const lines = [
    `Project: ${state.projectName}`,
    `Plan: ${done} done, ${pending} pending, ${skipped} skipped, ${failed} failed.`,
    running ? `Running now: ${running.label}` : state.isComplete ? "State: complete." : "State: waiting or planning.",
    `Model: ${describeDefaultModelSelection()}.`,
  ];
  input.store.getState().addMessage({ role: "assistant", content: lines.join("\n") });
  return { handled: true, action: "status" };
}

async function maybeHandleEnvIntent(input: DirectorInput, text: string): Promise<DirectorResult | null> {
  const parsed = interpretEnvBatch(text);
  const values = envInterpretationToRecord(parsed);
  if (Object.keys(values).length === 0) return null;

  const state = input.store.getState();
  const masked = maskEnvVars(Object.entries(values).map(([key, value]) => ({ key, value })));
  state.setEnvVars(
    state.envVars.map((envVar) =>
      values[envVar.key] !== undefined
        ? { ...envVar, value: values[envVar.key], status: "filled" as const, source: "chat" }
        : envVar
    )
  );

  try {
    await mergeEnvValues(input.cwd, values);
    input.store.getState().addLog({
      type: "success",
      content: `Applied ${Object.keys(values).length} environment value${Object.keys(values).length === 1 ? "" : "s"} from chat.`,
    });
  } catch (err) {
    input.store.getState().addLog({
      type: "warning",
      content: `Recorded env values in the TUI, but could not update .env: ${err instanceof Error ? err.message : "unknown error"}`,
    });
  }

  input.store.getState().addMessage({
    role: "thinking",
    content: `I parsed environment input and kept sensitive values masked: ${maskKeyValues(values) || masked.map((item) => `${item.key}=${item.value}`).join(", ")}.`,
  });
  if (parsed.ignored.some((line) => line.reason !== "blank" && line.reason !== "comment")) {
    input.store.getState().addNotice({
      type: "warning",
      message: "Some pasted env lines were ignored because they were not KEY=value pairs.",
    });
  }
  if (parsed.duplicates.length > 0) {
    input.store.getState().addNotice({
      type: "info",
      message: `Duplicate env keys used the last pasted value: ${parsed.duplicates.join(", ")}.`,
    });
  }
  return { handled: true, action: "env.apply" };
}

function maybeHandlePlanIntent(input: DirectorInput, text: string, intent: ParsedUserIntent): DirectorResult | null {
  const shouldSteer =
    intent.kind === "plan" && intent.confidence !== "low" ||
    /\b(skip|don'?t|dont|no|prefer|switch to|use)\b/i.test(text);
  if (!shouldSteer) return null;
  if (/\bmodel\b/i.test(text)) return null;

  const state = input.store.getState();
  if (state.steps.length === 0) return null;

  const steeringText = intent.confidence !== "low" ? intentToSteeringText(intent) : text;
  const adjusted = applySteeringToPlan(state.steps, steeringText);
  if (!adjusted.diff.added.length && !adjusted.diff.removed.length && !adjusted.diff.changed.length && !adjusted.diff.reordered.length) return null;
  state.setSteps(adjusted.steps);
  input.store.getState().addMessage({ role: "assistant", content: formatPlanChange(adjusted.diff) });
  for (const note of adjusted.notes) {
    input.store.getState().addMessage({ role: "thinking", content: note });
    input.store.getState().addLog({ type: "info", content: note });
  }
  if (intent.confidence !== "low") {
    input.store.getState().addMessage({
      role: "thinking",
      content: `Interpreted input as ${intent.compact}. I kept the original wording available for AI fallback.`,
    });
  }
  return { handled: true, action: "plan.adjust" };
}

function maybeHandlePromptIntent(input: DirectorInput, text: string): DirectorResult | null {
  const prompt = input.store.getState().pendingPrompt;
  if (!prompt) return null;

  const option = prompt.options?.find((candidate) => {
    const haystack = `${candidate.id} ${candidate.label}`.toLowerCase();
    return haystack.includes(text.toLowerCase()) || text.toLowerCase().includes(candidate.label.toLowerCase());
  });
  const proceed = /\b(yes|y|ok|okay|proceed|continue|confirm|looks good|run it)\b/i.test(text);
  const cancel = /\b(no|cancel|stop|abort|exit)\b/i.test(text);
  const selected = option || (proceed ? prompt.options?.[0] : undefined) || (cancel ? prompt.options?.find((o) => /cancel|stop|skip/i.test(o.id + o.label)) : undefined);
  const question = /\?$|\b(what|why|how|explain|tell me|show me)\b/i.test(text);

  if (!selected && question) return null;

  input.store.getState().answerPrompt({
    promptId: prompt.id,
    value: selected?.label || text,
    optionId: selected?.id,
  });
  input.store.getState().addMessage({
    role: "assistant",
    content: selected ? `Got it. I selected "${selected.label}" and will continue.` : "Got it. I will use that answer and continue.",
  });
  return { handled: true, action: "prompt.answer" };
}

async function switchModel(store: AppStore, model: AIModel, reason: string): Promise<void> {
  process.env.SETUPR_AI_MODEL = model.id;
  await updateConfig({ ai: { model: model.id, enabled: true } });
  const message = `${reason}\nActive model: ${model.id} via ${model.provider} (${formatModelPrice(model)}).`;
  store.getState().addNotice({ type: "info", message: `AI model: ${model.id}` });
  store.getState().addMessage({ role: "thinking", content: message });
  store.getState().addMessage({ role: "assistant", content: `Switched to ${model.id}. I will use it for the next AI decision.` });
}

function getCheapestAvailableModel(): AIModel | null {
  const priced = getAvailableModels()
    .map((model) => ({ model, cost: estimateModelWeightedCost(model) }))
    .filter((item): item is { model: AIModel; cost: number } => item.cost !== null);
  if (priced.length === 0) return null;
  return priced.sort((a, b) => a.cost - b.cost)[0].model;
}

function extractRequestedModel(text: string): string | null {
  const named = [...MODELS]
    .sort((a, b) => b.id.length - a.id.length)
    .find((model) => {
      const lower = text.toLowerCase();
      return lower.includes(model.id.toLowerCase()) || lower.includes(model.name.toLowerCase());
    });
  if (named) return named.id;

  const explicit = text.match(/\b(?:switch\s+model(?:\s+to)?|use|switch(?:\s+to)?|change(?:\s+the)?\s+model(?:\s+to)?|set(?:\s+the)?\s+model(?:\s+to)?)\s+["'`]?([A-Za-z0-9_.:/-]+)["'`]?/i)?.[1];
  if (explicit && !/^(model|to|the|cheapest|lowest)$/i.test(explicit)) return cleanModelToken(explicit);

  return null;
}

function hasModelIntentSignal(text: string): boolean {
  const lower = text.toLowerCase();
  if (/\bmodel\b/.test(lower)) return true;
  return MODELS.some((model) =>
    lower.includes(model.id.toLowerCase()) ||
    lower.includes(model.name.toLowerCase())
  );
}

function isAmbiguousModelChange(text: string): boolean {
  return /\b(?:change|switch|set|use)\b.{0,24}\bmodel\b|\bmodel\b.{0,24}\b(?:change|switch|set|use)\b/i.test(text);
}

function askWhichModelToChange(input: DirectorInput): DirectorResult {
  input.store.getState().setPendingPrompt({
    id: "director-ambiguous-model",
    type: "choice",
    title: "Which model should change?",
    message: "“Model” can mean Setupr's AI model, an app config/env value, or a code/schema model.",
    options: [
      { id: "setupr-ai-model", label: "Setupr AI model" },
      { id: "project-model", label: "Project code/config model" },
    ],
    includeOther: true,
    otherLabel: "Other...",
    createdAt: Date.now(),
  });
  input.store.getState().addMessage({
    role: "assistant",
    content: "Which model should change: Setupr's AI model, a project config/env model, or a code/schema model?",
  });
  return { handled: true, action: "model.clarify" };
}

function cleanModelToken(token: string): string {
  return token.replace(/[.,;:!?]+$/, "");
}

function findModelForRequest(requested: string): AIModel | undefined {
  const normalized = requested.toLowerCase();
  return (
    MODELS.find((model) => model.id.toLowerCase() === normalized) ||
    MODELS.find((model) => model.name.toLowerCase() === normalized) ||
    MODELS.find((model) => model.id.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized)) ||
    resolveModel(requested)
  );
}

export function summarizeDirectorPolicy(): string {
  const selection = selectDefaultModel();
  const providers = Object.keys(PROVIDERS).filter((provider) => getProviderEnvValue(provider as keyof typeof PROVIDERS));
  return [
    "The AI director can answer questions, update the setup plan, fill env values, answer prompts, and switch models from natural-language instructions.",
    `Default model policy: ${selection.model.id} via ${selection.model.provider} (${selection.reason}).`,
    providers.length > 0 ? `Configured providers: ${providers.join(", ")}.` : "No AI provider keys are configured yet.",
  ].join(" ");
}
