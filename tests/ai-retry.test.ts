import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIUserAbortError } from "openai/error";
import { acquireRateToken, withRetry } from "../src/ai/retry.js";
import { classifyAIProviderError } from "../src/errors/index.js";
import { loadConfig } from "../src/state/config.js";

const config = vi.hoisted(() => ({
  ai: { maxRetries: 2, retryDelayMs: 1000, timeoutMs: 5000, rateLimitPerMinute: 1 },
}));
vi.mock("../src/state/config.js", () => ({ loadConfig: vi.fn(async () => config) }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.spyOn(Math, "random").mockReturnValue(0);
  config.ai.rateLimitPerMinute = 1;
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("AI retry cancellation and deadlines", () => {
  it("hard-times out a transport that ignores its signal", async () => {
    const parent = new AbortController();
    const add = vi.spyOn(parent.signal, "addEventListener");
    const remove = vi.spyOn(parent.signal, "removeEventListener");
    let attemptSignal: AbortSignal | undefined;
    let rejectLate!: (error: Error) => void;
    const fn = vi.fn((signal: AbortSignal) => {
      attemptSignal = signal;
      return new Promise<never>((_resolve, reject) => { rejectLate = reject; });
    });
    const result = withRetry(fn, { timeoutMs: 100, maxRetries: 0, signal: parent.signal });
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError", message: expect.stringContaining("100ms") });
    await vi.advanceTimersByTimeAsync(100);
    await check;
    expect(attemptSignal?.aborted).toBe(true);
    expect(classifyAIProviderError(attemptSignal?.reason).code).toBe("AI_PROVIDER_TIMEOUT");
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    rejectLate(new Error("late transport failure"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("retries hard timeouts with a fresh signal", async () => {
    const signals: AbortSignal[] = [];
    const fn = vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? new Promise<string>(() => {}) : Promise.resolve("answer");
    });
    const onProgress = vi.fn();
    const result = withRetry(fn, { timeoutMs: 100, baseDelayMs: 10, maxRetries: 1, onProgress });
    await vi.advanceTimersByTimeAsync(110);
    await expect(result).resolves.toBe("answer");
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Retry 1/1"));
  });

  it("keeps TimeoutError when a cooperative transport rejects with AbortError", async () => {
    const fn = vi.fn((signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = withRetry(fn, { timeoutMs: 10, maxRetries: 0 });
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await check;
  });

  it("ignores a late success after cancellation", async () => {
    const controller = new AbortController();
    let resolveLate!: (value: string) => void;
    const fn = vi.fn(() => new Promise<string>((resolve) => { resolveLate = resolve; }));
    const result = withRetry(fn, { signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await check;
    resolveLate("too late");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).rejects.toBe(controller.signal.reason);
  });

  it("cancels even while config loading is pending", async () => {
    vi.mocked(loadConfig).mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const fn = vi.fn();
    const result = withRetry(fn, { signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await check;
    expect(fn).not.toHaveBeenCalled();
  });

  it("cleans up on success and synchronous failure", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await expect(withRetry(async () => "answer", { signal: controller.signal })).resolves.toBe("answer");
    const error = new Error("401 invalid api key");
    await expect(withRetry(() => { throw error; }, { signal: controller.signal })).rejects.toBe(error);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect(remove.mock.calls.map(([event, listener]) => [event, listener]))
      .toEqual(add.mock.calls.map(([event, listener]) => [event, listener]));
  });

  it("does not start a pre-aborted request", async () => {
    const controller = new AbortController();
    controller.abort(new Error("conversation budget exhausted"));
    const fn = vi.fn();
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(fn).not.toHaveBeenCalled();
  });

  it("cancels an in-flight hung attempt immediately without retries", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const fn = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise(() => {});
    });
    const onRetry = vi.fn();
    const result = withRetry(fn, { signal: controller.signal, onRetry, timeoutMs: 0 });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await check;
    expect(signal?.aborted).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("cancels during backoff and removes its listener and timer", async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const error = new Error("503 unavailable");
    const fn = vi.fn().mockRejectedValue(error);
    const onProgress = vi.fn();
    const onRetry = vi.fn();
    const result = withRetry(fn, { signal: controller.signal, onProgress, onRetry });
    const check = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("Retry 1/2 in 1.0s"));
    expect(onRetry).toHaveBeenCalledWith(1, expect.objectContaining({ code: "AI_PROVIDER_UNAVAILABLE" }), 1000);
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await check;
    expect(fn).toHaveBeenCalledTimes(1);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
  });

  it("handles cancellation from a progress callback before sleeping", async () => {
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error("503 unavailable"));
    await expect(withRetry(fn, {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each(["AbortError", "APIUserAbortError"])("never retries %s even without a parent signal", async (name) => {
    const error = Object.assign(new Error("Request aborted"), { name });
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries the installed SDK's user-abort error, whose name is Error", async () => {
    const error = new APIUserAbortError();
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    [Object.assign(new Error("provider refused request"), { status: 401 }), "AI_PROVIDER_AUTH_FAILED"],
    [Object.assign(new Error("provider refused request"), { status: 403 }), "AI_PROVIDER_AUTH_FAILED"],
    [Object.assign(new Error("too many requests"), { status: 429, code: "insufficient_quota" }), "AI_PROVIDER_QUOTA_EXHAUSTED"],
    [new Error("Invalid response: no answer"), "AI_PROVIDER_PROTOCOL_ERROR"],
  ])("preserves nonretryable classification: %s", async (error, code) => {
    const fn = vi.fn().mockRejectedValue(error);
    await expect(withRetry(fn)).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(classifyAIProviderError(error).code).toBe(code);
  });

  it("uses bounded exponential backoff and preserves the final error", async () => {
    const error = Object.assign(new Error("Too many requests"), { status: 429 });
    const fn = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn();
    const result = withRetry(fn, { onRetry });
    const check = expect(result).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(3000);
    await check;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry.mock.calls.map(([attempt, , delay]) => [attempt, delay])).toEqual([[1, 1000], [2, 2000]]);
  });
});

describe("AI rate limiter", () => {
  it("cancels during a rate wait without consuming the next token", async () => {
    const provider = "cancelled-rate-wait";
    await acquireRateToken(provider);
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const onProgress = vi.fn();
    const waiting = acquireRateToken(provider, { signal: controller.signal, onProgress });
    const check = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining("60.0s"));
    controller.abort();
    await check;
    expect(vi.getTimerCount()).toBe(0);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    await vi.advanceTimersByTimeAsync(60000);
    await expect(acquireRateToken(provider)).resolves.toBeUndefined();
  });

  it("does not oversubscribe a refilled bucket when concurrent waiters wake", async () => {
    const provider = "concurrent-rate-wait";
    await acquireRateToken(provider);
    const finished: string[] = [];
    const one = acquireRateToken(provider).then(() => { finished.push("one"); });
    const two = acquireRateToken(provider).then(() => { finished.push("two"); });
    await vi.advanceTimersByTimeAsync(60000);
    expect(finished).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(60000);
    await Promise.all([one, two]);
    expect(finished).toEqual(["one", "two"]);
  });

  it("honors cancellation even with rate limiting disabled", async () => {
    config.ai.rateLimitPerMinute = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(acquireRateToken("disabled", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
