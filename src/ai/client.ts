import OpenAI from "openai";
import {
  PROVIDERS,
  getDefaultModel,
  getAIEnvValue,
  getProviderEnvValue,
  resolveModel,
  type AIModel,
  type AIProvider,
} from "./models.js";
import { withRetry, acquireRateToken } from "./retry.js";
import { loadConfig } from "../state/config.js";
import { throwIfAborted, withCancellation } from "./cancellation.js";
import { extractVisibleAnswer } from "./response.js";

const clients = new Map<AIProvider, { apiKey: string; client: OpenAI }>();

function getClientForProvider(provider: AIProvider): OpenAI | null {
  const config = PROVIDERS[provider];
  const apiKey = getProviderEnvValue(provider);

  if (!apiKey) return null;
  const cached = clients.get(provider);
  if (cached?.apiKey === apiKey) return cached.client;

  const client = new OpenAI({
    apiKey,
    baseURL: config.baseURL,
  });

  clients.set(provider, { apiKey, client });
  return client;
}

export function hasAIKey(): boolean {
  const model = getDefaultModel();
  return !!getProviderEnvValue(model.provider);
}

export function getModel(): string {
  return getDefaultModel().id;
}

export function getActiveModel(): AIModel {
  return getDefaultModel();
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  model?: string;
  stream?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

interface AnthropicResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface GoogleResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }>;
  usageMetadata?: { totalTokenCount?: number };
}

export async function chat(
  messages: ChatMessage[],
  options?: ChatOptions
): Promise<{ content: string; tokens: number; model: string }> {
  throwIfAborted(options?.signal);
  const modelId = options?.model || getModel();
  const model = resolveModel(modelId) || getDefaultModel();
  const client = getClientForProvider(model.provider);

  if (!client) {
    const providerConfig = PROVIDERS[model.provider];
    throw new Error(
      `No API key for ${model.provider}. Run setupr auth set-key ${model.provider}, or set ${providerConfig.envKey} in your environment for this shell.`
    );
  }

  const config = await withCancellation(() => loadConfig(), { signal: options?.signal });

  return withRetry(
    async (signal) => {
      await acquireRateToken(model.provider, { signal, onProgress: options?.onProgress });
      throwIfAborted(signal);
      const opts: ChatOptions = {
        ...options,
        timeoutMs: options?.timeoutMs ?? config.ai.timeoutMs,
      };

      if (model.provider === "anthropic") {
        return chatAnthropic(model, messages, opts, signal);
      }

      if (model.provider === "google") {
        return chatGoogle(model, messages, opts, signal);
      }

      return chatOpenAICompatible(client, model, messages, opts, signal);
    },
    {
      maxRetries: options?.maxRetries ?? config.ai.maxRetries,
      baseDelayMs: config.ai.retryDelayMs,
      timeoutMs: options?.timeoutMs ?? config.ai.timeoutMs,
      signal: options?.signal,
      onProgress: options?.onProgress,
    }
  );
}

async function chatOpenAICompatible(
  client: OpenAI,
  model: AIModel,
  messages: ChatMessage[],
  options?: ChatOptions,
  signal?: AbortSignal
): Promise<{ content: string; tokens: number; model: string }> {
  const response = await client.chat.completions.create({
    model: model.upstreamId ?? model.id,
    messages,
    temperature: options?.temperature ?? 0.3,
    max_tokens: options?.maxTokens ?? 2048,
  }, {
    timeout: options?.timeoutMs,
    maxRetries: 0,
    signal,
  });

  const choice = response.choices?.[0];
  const usage = response.usage;

  return {
    content: extractVisibleAnswer(choice?.message?.content, model.id, choice?.finish_reason),
    tokens: (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0),
    model: model.id,
  };
}

async function chatAnthropic(
  model: AIModel,
  messages: ChatMessage[],
  options?: ChatOptions,
  signal?: AbortSignal
): Promise<{ content: string; tokens: number; model: string }> {
  const apiKey = getAIEnvValue("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const body: Record<string, unknown> = {
    model: model.id,
    max_tokens: options?.maxTokens ?? 2048,
    messages: nonSystemMessages.map((m) => ({ role: m.role, content: m.content })),
  };

  if (systemMsg) {
    body.system = systemMsg.content;
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = (await response.text()).slice(0, 1000);
    throw new Error(`Anthropic API error: ${response.status} ${err}`);
  }

  const data = await response.json() as AnthropicResponse;
  const content = extractVisibleAnswer(
    data.content?.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n"),
    model.id,
    data.stop_reason
  );
  const inputTokens = data.usage?.input_tokens || 0;
  const outputTokens = data.usage?.output_tokens || 0;

  return { content, tokens: inputTokens + outputTokens, model: model.id };
}

async function chatGoogle(
  model: AIModel,
  messages: ChatMessage[],
  options?: ChatOptions,
  signal?: AbortSignal
): Promise<{ content: string; tokens: number; model: string }> {
  const apiKey = getAIEnvValue("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const contents = nonSystemMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const body: Record<string, unknown> = { contents };
  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }
  body.generationConfig = {
    temperature: options?.temperature ?? 0.3,
    maxOutputTokens: options?.maxTokens ?? 2048,
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const err = (await response.text()).slice(0, 1000);
    throw new Error(`Google AI error: ${response.status} ${err}`);
  }

  const data = await response.json() as GoogleResponse;
  const candidate = data.candidates?.[0];
  const content = extractVisibleAnswer(
    candidate?.content?.parts?.filter((part) => !part.thought && typeof part.text === "string").map((part) => part.text).join("\n"),
    model.id,
    candidate?.finishReason
  );
  const totalTokens = data.usageMetadata?.totalTokenCount || 0;

  return { content, tokens: totalTokens, model: model.id };
}

export function listConfiguredProviders(): AIProvider[] {
  const configured: AIProvider[] = [];
  for (const provider of Object.keys(PROVIDERS)) {
    if (getProviderEnvValue(provider as AIProvider)) {
      configured.push(provider as AIProvider);
    }
  }
  return configured;
}
