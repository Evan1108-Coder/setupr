import { loadConfig } from "../state/config.js";
import { classifyAIProviderError } from "../errors/index.js";
import type { SetuprError } from "../errors/types.js";
import { abortableSleep, isCancellation, throwIfAborted, withCancellation } from "./cancellation.js";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onRetry?: (attempt: number, error: SetuprError, delayMs: number) => void;
}

export async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const config = await withCancellation(() => loadConfig(), { signal: options?.signal });
  const maxRetries = options?.maxRetries ?? config.ai.maxRetries;
  const baseDelay = options?.baseDelayMs ?? config.ai.retryDelayMs;
  const timeoutMs = options?.timeoutMs ?? config.ai.timeoutMs;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    throwIfAborted(options?.signal);
    try {
      return await withCancellation(fn, { signal: options?.signal, timeoutMs });
    } catch (error) {
      throwIfAborted(options?.signal);
      if (isCancellation(error)) throw error;
      lastError = error;

      if (attempt >= maxRetries) break;

      const classified = classifyAIProviderError(error);
      if (!isRetryable(classified)) break;

      const delay = calculateBackoff(attempt, baseDelay);
      options?.onProgress?.(`${classified.title}. Retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s; cancel to stop waiting.`);
      options?.onRetry?.(attempt + 1, classified, delay);
      await abortableSleep(delay, options?.signal);
    }
  }

  throw lastError;
}

function isRetryable(error: SetuprError): boolean {
  const retryableCodes = new Set([
    "AI_PROVIDER_TIMEOUT",
    "AI_PROVIDER_RATE_LIMITED",
    "AI_PROVIDER_UNAVAILABLE",
    "NETWORK_UNAVAILABLE",
  ]);
  return retryableCodes.has(error.code);
}

function calculateBackoff(attempt: number, baseDelay: number): number {
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay * 0.5;
  return Math.min(exponential + jitter, 30000);
}

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

const providerBuckets = new Map<string, RateBucket>();

export async function acquireRateToken(
  provider: string,
  options?: Pick<RetryOptions, "signal" | "onProgress">
): Promise<void> {
  const config = await withCancellation(() => loadConfig(), { signal: options?.signal });
  throwIfAborted(options?.signal);
  const limit = config.ai.rateLimitPerMinute;
  if (limit <= 0) return;

  let bucket = providerBuckets.get(provider);

  if (!bucket) {
    bucket = { tokens: limit, lastRefill: Date.now() };
    providerBuckets.set(provider, bucket);
  }

  while (true) {
    throwIfAborted(options?.signal);
    const now = Date.now();
    const periods = Math.floor((now - bucket.lastRefill) / 60000);
    if (periods > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + periods * limit);
      bucket.lastRefill += periods * 60000;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return;
    }
    const waitMs = Math.max(60000 - (now - bucket.lastRefill), 1);
    options?.onProgress?.(`Waiting ${(waitMs / 1000).toFixed(1)}s for the local ${provider} rate limit; cancel to stop waiting.`);
    await abortableSleep(waitMs, options?.signal);
  }
}
