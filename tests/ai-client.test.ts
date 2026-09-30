import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../src/ai/client.js";
import { classifyAIProviderError } from "../src/errors/index.js";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  fetch: vi.fn(),
  config: { ai: { maxRetries: 2, retryDelayMs: 1000, timeoutMs: 5000, rateLimitPerMinute: 0 } },
}));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));
vi.mock("../src/state/config.js", () => ({ loadConfig: vi.fn(async () => mocks.config) }));
vi.mock("../src/ai/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/models.js")>();
  return {
    ...actual,
    getAIEnvValue: () => "test-key-not-real",
    getProviderEnvValue: () => "test-key-not-real",
    getDefaultModel: () => actual.resolveModel("gpt-4o-mini"),
  };
});

const messages = [{ role: "user" as const, content: "Hello" }];
const providers = ["gpt-4o-mini", "claude-sonnet-4-6", "gemini-3-flash"];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, "random").mockReturnValue(0);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.create.mockReset();
  mocks.fetch.mockReset();
  mocks.config.ai.rateLimitPerMinute = 0;
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(data: unknown): void {
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => data });
}

describe("AI provider client", () => {
  it("keeps the OpenAI return shape and disables SDK retries", async () => {
    mocks.create.mockResolvedValue({
      choices: [{ message: { content: "<think>private</think>Answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 6 },
    });
    await expect(chat(messages)).resolves.toEqual({ content: "Answer", tokens: 10, model: "gpt-4o-mini" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ messages }), expect.objectContaining({
      timeout: 5000, maxRetries: 0, signal: expect.any(AbortSignal),
    }));
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("collects all Anthropic text blocks and excludes native reasoning", async () => {
    respond({
      content: [
        { type: "thinking", thinking: "hidden", text: "not answer text" },
        { type: "text", text: "<think>private</think>First" },
        { type: "redacted_thinking", data: "hidden" },
        { type: "text", text: "Second" },
      ],
      usage: { input_tokens: 3, output_tokens: 7 },
    });
    await expect(chat(messages, { model: "claude-sonnet-4-6" })).resolves.toEqual({
      content: "First\nSecond", tokens: 10, model: "claude-sonnet-4-6",
    });
  });

  it("collects all Google non-thought text parts of the first candidate", async () => {
    respond({
      candidates: [
        { content: { parts: [
          { thought: true, text: "private" },
          { text: "First" },
          { inlineData: { data: "non-text" } },
          { thought: false, text: "<thinking>private</thinking>Second" },
        ] } },
        { content: { parts: [{ text: "Alternative answer" }] } },
      ],
      usageMetadata: { totalTokenCount: 12 },
    });
    await expect(chat(messages, { model: "gemini-3-flash" })).resolves.toEqual({
      content: "First\nSecond", tokens: 12, model: "gemini-3-flash",
    });
  });

  it.each(providers)("cancels %s even when transport ignores the signal", async (model) => {
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = chat(messages, { model, signal: controller.signal, onProgress });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    const transport = model === "gpt-4o-mini" ? mocks.create : mocks.fetch;
    const signal = transport.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    await check;
    expect(signal.aborted).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it.each(providers)("enforces a hard deadline for %s", async (model) => {
    mocks.create.mockImplementation(() => new Promise(() => {}));
    mocks.fetch.mockImplementation(() => new Promise(() => {}));
    const result = chat(messages, { model, timeoutMs: 50, maxRetries: 0 });
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await check;
  });

  it("hard-times out response body parsing as well as the initial fetch", async () => {
    mocks.fetch.mockResolvedValue({ ok: true, json: () => new Promise(() => {}) });
    const result = chat(messages, { model: "claude-sonnet-4-6", timeoutMs: 50, maxRetries: 0 });
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await check;
  });

  it.each(providers)("rejects blank %s answers without retries", async (model) => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "  " } }] });
    respond({ content: [{ type: "text", text: " \n " }], candidates: [{ content: { parts: [{ text: "  " }] } }] });
    await expect(chat(messages, { model })).rejects.toThrow(/Invalid response.*no answer/);
    expect(mocks.create.mock.calls.length + mocks.fetch.mock.calls.length).toBe(1);
  });

  it.each(providers)("rejects missing %s answer parts as a useful protocol error", async (model) => {
    mocks.create.mockResolvedValue({});
    respond({});
    const error = await chat(messages, { model }).catch((error: unknown) => error);
    expect(classifyAIProviderError(error).code).toBe("AI_PROVIDER_PROTOCOL_ERROR");
    expect(String(error)).toContain("no answer");
    expect(mocks.create.mock.calls.length + mocks.fetch.mock.calls.length).toBe(1);
  });

  it("does not reach any transport when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("Conversation deadline", "TimeoutError"));
    await expect(chat(messages, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(providers)("rejects truncated reasoning-only %s output", async (model) => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "<think>unfinished" }, finish_reason: "length" }] });
    respond({
      content: [{ type: "thinking", thinking: "unfinished" }], stop_reason: "max_tokens",
      candidates: [{ content: { parts: [{ thought: true, text: "unfinished" }] }, finishReason: "MAX_TOKENS" }],
    });
    await expect(chat(messages, { model })).rejects.toThrow(/Increase maxTokens/);
    expect(mocks.create.mock.calls.length + mocks.fetch.mock.calls.length).toBe(1);
  });

  it.each([
    [401, "invalid api key", "AI_PROVIDER_AUTH_FAILED"],
    [429, "insufficient_quota", "AI_PROVIDER_QUOTA_EXHAUSTED"],
  ])("preserves HTTP %s error classification and does not retry", async (status, body, code) => {
    mocks.fetch.mockResolvedValue({ ok: false, status, text: async () => body });
    const error = await chat(messages, { model: "claude-sonnet-4-6" }).catch((error: unknown) => error);
    expect(classifyAIProviderError(error).code).toBe(code);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("exposes retry progress and cancels before the retry reaches transport", async () => {
    mocks.create.mockRejectedValue(Object.assign(new Error("rate limit"), { status: 429 }));
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = chat(messages, { signal: controller.signal, onProgress });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Retry 1/2 in 1.0s"));
    controller.abort();
    await check;
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued chat before it reaches transport", async () => {
    mocks.config.ai.rateLimitPerMinute = 1;
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "Answer" } }] });
    await chat(messages);
    const controller = new AbortController();
    const onProgress = vi.fn();
    const result = chat(messages, { signal: controller.signal, onProgress });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("local openai rate limit"));
    controller.abort();
    await check;
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it("hard-times out the rate wait without starting transport later", async () => {
    mocks.config.ai.rateLimitPerMinute = 1;
    respond({ content: [{ type: "text", text: "Answer" }] });
    await chat(messages, { model: "claude-sonnet-4-6" });
    const result = chat(messages, { model: "claude-sonnet-4-6", timeoutMs: 100, maxRetries: 0 });
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("acquires a rate token for retries too", async () => {
    mocks.config.ai.rateLimitPerMinute = 1;
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 503, text: async () => "unavailable" });
    respond({ candidates: [{ content: { parts: [{ text: "Answer" }] } }] });
    const onProgress = vi.fn();
    const result = chat(messages, { model: "gemini-3-flash", timeoutMs: 70000, maxRetries: 1, onProgress });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("local google rate limit"));
    await vi.advanceTimersByTimeAsync(59000);
    await expect(result).resolves.toMatchObject({ content: "Answer" });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });
});
