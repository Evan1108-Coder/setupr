import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { intelligentResponse, type IntelligenceOptions } from "../src/ai/intelligence.js";
import type { ChatMessage, ChatOptions } from "../src/ai/client.js";
import type { AIModel } from "../src/ai/models.js";
import type { ScanResult } from "../src/scanner/index.js";

type Answer = { content: string; tokens: number; model: string };
type CacheEntry = { response: string; tokens: number; timestamp: number };

const mocks = vi.hoisted(() => {
  const models: AIModel[] = [
    ["selected-model", "openai"],
    ["gpt-4o-mini", "openai"],
    ["gpt-4o", "openai"],
    ["fallback-google", "google"],
    ["fallback-anthropic", "anthropic"],
  ].map(([id, provider]) => ({
    id, name: id, provider: provider as AIModel["provider"],
    maxTokens: 4096, costPer1kInput: 1, costPer1kOutput: 1, supportsStreaming: false,
  }));
  return {
    models,
    active: models[0],
    chat: vi.fn<(messages: ChatMessage[], options?: ChatOptions) => Promise<Answer>>(),
    hasAIKey: vi.fn(),
    getCached: vi.fn<(key: string) => Promise<CacheEntry | null>>(),
    setCache: vi.fn<(key: string, response: string, tokens: number) => Promise<void>>(),
    buildCacheKey: vi.fn<(query: string, context: string) => string>(),
    loadConfig: vi.fn(),
    cache: new Map<string, CacheEntry>(),
    ai: { enabled: true, timeoutMs: 30000, maxRetries: 9, retryDelayMs: 1000, rateLimitPerMinute: 20 },
  };
});

vi.mock("../src/ai/client.js", () => ({
  chat: mocks.chat,
  hasAIKey: mocks.hasAIKey,
  getActiveModel: () => mocks.active,
}));
vi.mock("../src/ai/cache.js", () => ({
  getCached: mocks.getCached,
  setCache: mocks.setCache,
  buildCacheKey: mocks.buildCacheKey,
}));
vi.mock("../src/state/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../src/ai/models.js", () => ({
  MODELS: mocks.models,
  PROVIDERS: {},
  getAvailableModels: () => mocks.models,
  getProviderEnvValue: () => undefined,
  describeDefaultModelSelection: () => mocks.active.id,
}));

const scan: ScanResult = {
  language: "JavaScript", framework: "React", packageManager: "npm",
  runtime: { name: "node", version: "20" }, services: [], monorepo: null,
  scripts: { dev: "vite", build: "vite build" }, dependencies: { prod: 1, dev: 1 },
  configFiles: ["package.json"],
};
const query = "Explain the tradeoffs of this architecture";
const contextDSL = "js/react/npm";
const answer: Answer = { content: "A useful answer", tokens: 25, model: "selected-model" };

function request(options?: IntelligenceOptions | ChatMessage[]) {
  return intelligentResponse(query, scan, contextDSL, options);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The real transport settles on abort; this mock preserves that boundary contract.
function waitForAbort(_messages: ChatMessage[], options?: ChatOptions): Promise<Answer> {
  const signal = options!.signal!;
  return new Promise((_resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.resetAllMocks();
  mocks.cache.clear();
  mocks.active = mocks.models[0];
  mocks.ai.enabled = true;
  mocks.ai.timeoutMs = 30000;
  mocks.hasAIKey.mockReturnValue(true);
  mocks.loadConfig.mockResolvedValue({ ai: mocks.ai });
  mocks.chat.mockResolvedValue(answer);
  mocks.buildCacheKey.mockImplementation((query, context) => `${query}::${context}`);
  mocks.getCached.mockImplementation(async (key) => mocks.cache.get(key) ?? null);
  mocks.setCache.mockImplementation(async (key, response, tokens) => {
    mocks.cache.set(key, { response, tokens, timestamp: Date.now() });
  });
});

afterEach(() => {
  const pendingTimers = vi.getTimerCount();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(pendingTimers).toBe(0);
});

describe("conversational provider lifecycle", () => {
  it("starts with the configured active model and forwards progress with no transport retries", async () => {
    const onProgress = vi.fn();
    mocks.chat.mockImplementation(async (_messages, options) => {
      options?.onProgress?.("Provider is waiting for a rate token");
      return answer;
    });
    await expect(request({ onProgress })).resolves.toEqual({
      response: answer.content, level: "live", cost: answer.tokens * 0.000001,
    });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.chat.mock.calls[0][1]).toMatchObject({
      model: "selected-model", maxRetries: 0, timeoutMs: 30000,
      signal: expect.any(AbortSignal), onProgress,
    });
    expect(onProgress.mock.calls.map(([message]) => message)).toEqual([
      "Waiting for selected-model", "Provider is waiting for a rate token",
    ]);
  });

  it("tries at most two fallback models even when more are configured", async () => {
    mocks.chat.mockRejectedValue(new Error("503 unavailable"));
    const onProgress = vi.fn();
    const result = await request({ onProgress });
    expect(mocks.chat.mock.calls.map(([, options]) => options?.model))
      .toEqual(["selected-model", "gpt-4o-mini", "gpt-4o"]);
    expect(mocks.chat.mock.calls.every(([, options]) => options?.maxRetries === 0)).toBe(true);
    expect(result).toMatchObject({ level: "pattern", cost: 0, failed: true });
    expect(result.response).toContain("AI unavailable:");
    expect(onProgress).toHaveBeenCalledWith("Trying fallback gpt-4o-mini");
    expect(onProgress).toHaveBeenCalledWith("Trying fallback gpt-4o");
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("does not repeat the selected model when the fallback profile includes it", async () => {
    mocks.active = mocks.models[1];
    mocks.chat.mockRejectedValue(new Error("503 unavailable"));
    await request();
    expect(mocks.chat.mock.calls.map(([, options]) => options?.model))
      .toEqual(["gpt-4o-mini", "gpt-4o", "fallback-google"]);
  });

  it.each(["Request timed out", "429 rate limit", "429 insufficient_quota", "503 unavailable"])(
    "uses a fallback after %s, without caching it as the selected model", async (message) => {
      mocks.chat.mockRejectedValueOnce(new Error(message));
      const result = await request();
      expect(mocks.chat).toHaveBeenCalledTimes(2);
      expect(result.response).toContain("Used gpt-4o-mini after selected-model failed");
      expect(result.response).toContain("your saved model is unchanged");
      expect(mocks.active.id).toBe("selected-model");
      expect(mocks.setCache).not.toHaveBeenCalled();
    }
  );

  it.each(["401 invalid API key", "Invalid response: no answer"])(
    "does not fan out after a non-retryable failure: %s", async (message) => {
      mocks.chat.mockRejectedValue(new Error(message));
      expect(await request()).toMatchObject({ response: expect.stringContaining("AI unavailable:"), failed: true });
      expect(mocks.chat).toHaveBeenCalledTimes(1);
      expect(mocks.setCache).not.toHaveBeenCalled();
    }
  );

  it("clamps later attempt timeouts to the remaining total budget", async () => {
    const first = deferred<Answer>();
    const second = deferred<Answer>();
    mocks.chat.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const result = request({ timeoutMs: 60000 });
    await vi.advanceTimersByTimeAsync(26000);
    first.reject(new Error("503 unavailable"));
    await vi.advanceTimersByTimeAsync(17000);
    second.reject(new Error("503 unavailable"));
    await result;
    expect(mocks.chat.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([30000, 18000, 17000]);
  });

  it("releases a stalled conversation at the default 60-second deadline", async () => {
    mocks.chat.mockImplementation(waitForAbort);
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    let settled = false;
    const result = request({ signal: parent.signal }).then((value) => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(59999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({ level: "pattern", response: expect.stringContaining("AI_PROVIDER_TIMEOUT") });
    expect(mocks.chat.mock.calls[0][1]?.signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(parent.signal.aborted).toBe(false);
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.setCache).not.toHaveBeenCalled();
    expect(remove.mock.calls.map(([event, listener]) => [event, listener]))
      .toEqual(add.mock.calls.map(([event, listener]) => [event, listener]));
  });

  it("honors a shorter caller budget and clears its deadline after timeout", async () => {
    mocks.chat.mockImplementation(waitForAbort);
    const result = request({ timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(50);
    expect((await result).response).toContain("AI_PROVIDER_TIMEOUT");
    expect(mocks.chat.mock.calls[0][1]?.timeoutMs).toBe(50);
  });

  it.each([new DOMException("Stopped", "AbortError"), new DOMException("Caller budget", "TimeoutError")])(
    "rejects caller cancellation instead of returning an AI failure message: %s", async (reason) => {
      mocks.chat.mockImplementation(waitForAbort);
      const parent = new AbortController();
      const result = request({ signal: parent.signal });
      const check = expect(result).rejects.toBe(reason);
      await vi.advanceTimersByTimeAsync(0);
      parent.abort(reason);
      await check;
      expect(mocks.chat.mock.calls[0][1]?.signal?.reason).toBe(reason);
      expect(mocks.chat).toHaveBeenCalledTimes(1);
      expect(mocks.setCache).not.toHaveBeenCalled();
    }
  );

  it("does not return even a pattern response after pre-cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(intelligentResponse("what is the stack?", scan, contextDSL, { signal: controller.signal }))
      .rejects.toBe(controller.signal.reason);
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.getCached).not.toHaveBeenCalled();
  });

  it("rejects cancellation during a cache lookup without returning cached text", async () => {
    const cached = deferred<CacheEntry | null>();
    mocks.getCached.mockReturnValueOnce(cached.promise);
    const controller = new AbortController();
    const result = request({ signal: controller.signal });
    const check = expect(result).rejects.toBeInstanceOf(DOMException);
    controller.abort();
    cached.resolve({ response: "Cached answer", tokens: 0, timestamp: 0 });
    await check;
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("does not accept or cache a late transport success after cancellation", async () => {
    const pending = deferred<Answer>();
    mocks.chat.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const result = request({ signal: controller.signal });
    const check = expect(result).rejects.toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    pending.resolve(answer);
    await check;
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it.each([true, false])("rejects cancellation during config loading when AI enabled is %s", async (enabled) => {
    const config = deferred<{ ai: typeof mocks.ai }>();
    mocks.loadConfig.mockReturnValueOnce(config.promise);
    const controller = new AbortController();
    const result = request({ signal: controller.signal });
    const check = expect(result).rejects.toBeInstanceOf(DOMException);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    config.resolve({ ai: { ...mocks.ai, enabled } });
    await check;
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("clears the parent listener and timer on success", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await request({ signal: controller.signal });
    expect(remove.mock.calls.map(([event, listener]) => [event, listener]))
      .toEqual(add.mock.calls.map(([event, listener]) => [event, listener]));
  });

  it("does not call a live provider when AI is disabled", async () => {
    mocks.ai.enabled = false;
    await expect(request()).resolves.toMatchObject({ level: "pattern", response: expect.stringContaining("AI is disabled") });
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(mocks.setCache).not.toHaveBeenCalled();
  });
});

describe("conversation-aware cache and response hygiene", () => {
  it("uses the version-2 key with model, project context, director context, and role history", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Earlier question" }, { role: "assistant", content: "Earlier answer" }];
    await request({ messages, directorContext: "director snapshot" });
    expect(mocks.buildCacheKey).toHaveBeenCalledWith(query, JSON.stringify({
      version: 2, model: "selected-model", contextDSL, directorContext: "director snapshot", messages,
    }));
    await expect(request({ messages, directorContext: "director snapshot" })).resolves.toMatchObject({ level: "cached" });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it.each(["model", "history content", "history role", "project context", "director context", "query"])(
    "does not reuse a response after changing %s", async (dimension) => {
      const options: IntelligenceOptions = { messages: [{ role: "user", content: "Earlier question" }], directorContext: "first snapshot" };
      await request(options);
      let nextQuery = query;
      let nextContext = contextDSL;
      if (dimension === "model") mocks.active = mocks.models[1];
      if (dimension === "history content") options.messages = [{ role: "user", content: "Different question" }];
      if (dimension === "history role") options.messages = [{ role: "assistant", content: "Earlier question" }];
      if (dimension === "project context") nextContext = "python/fastapi/pip";
      if (dimension === "director context") options.directorContext = "second snapshot";
      if (dimension === "query") nextQuery = "Explain a different architectural decision";
      expect((await intelligentResponse(nextQuery, scan, nextContext, options)).level).toBe("live");
      expect(mocks.chat).toHaveBeenCalledTimes(2);
      expect(new Set(mocks.getCached.mock.calls.map(([key]) => key)).size).toBe(2);
    }
  );

  it("preserves the legacy messages-array input while using history-aware caching", async () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "Previous answer" }];
    await request(history);
    const sent = mocks.chat.mock.calls[0][0];
    expect(sent.slice(1)).toEqual([...history, { role: "user", content: query }]);
    expect(JSON.parse(mocks.buildCacheKey.mock.calls[0][1]).messages).toEqual(history);
  });

  it.each(["", " \n ", "<think>old private reasoning</think>", "<thinking>unfinished"])(
    "ignores unusable cached output: %s", async (response) => {
      mocks.getCached.mockResolvedValueOnce({ response, tokens: 5, timestamp: 0 });
      await expect(request()).resolves.toMatchObject({ response: answer.content, level: "live" });
      expect(mocks.chat).toHaveBeenCalledTimes(1);
      expect(mocks.setCache).toHaveBeenCalledWith(expect.any(String), answer.content, answer.tokens);
    }
  );

  it("cleans old cached reasoning and secrets without making a live call", async () => {
    mocks.getCached.mockResolvedValueOnce({
      response: "<think>old private reasoning</think>Visible answer: sk-testsecretvalue123",
      tokens: 5, timestamp: 0,
    });
    const result = await request();
    expect(result).toEqual({ response: "Visible answer: sk-****", level: "cached", cost: 0 });
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("preserves fenced literal tags in cached explanations", async () => {
    const response = "```html\n<think>literal example</think>\n```";
    mocks.getCached.mockResolvedValueOnce({ response, tokens: 0, timestamp: 0 });
    expect((await request()).response).toBe(response);
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it.each(["", "<think>only private reasoning</think>"])("never caches an invalid live answer: %s", async (content) => {
    mocks.chat.mockResolvedValueOnce({ ...answer, content });
    const result = await request();
    expect(result.response).toContain("AI_PROVIDER_PROTOCOL_ERROR");
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    expect(mocks.setCache).not.toHaveBeenCalled();
  });

  it("sanitizes outbound history and stores only cleaned visible response text", async () => {
    mocks.chat.mockResolvedValueOnce({ ...answer, content: "<think>private</think>Answer sk-testresponse12345" });
    const result = await request({
      messages: [{ role: "user", content: "Token sk-testhistory12345" }],
      directorContext: "token sk-testcontext12345",
    });
    const sent = JSON.stringify(mocks.chat.mock.calls[0][0]);
    expect(sent).not.toContain("sk-testhistory12345");
    expect(sent).not.toContain("sk-testcontext12345");
    expect(result.response).toBe("Answer sk-****");
    expect(mocks.setCache).toHaveBeenCalledWith(expect.any(String), "Answer sk-****", answer.tokens);
  });
});
