import { APIUserAbortError } from "openai/error";

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("AI request cancelled", "AbortError");
}

export function isCancellation(error: unknown): boolean {
  if (error instanceof APIUserAbortError) return true;
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: string; code?: string };
  return value.name === "AbortError" || value.name === "APIUserAbortError" || value.code === "ABORT_ERR";
}

// Settle independently of the transport: not every SDK or mock honors abort.
export function withCancellation<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const { signal, timeoutMs = 0 } = options;
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("AI request cancelled", "AbortError"));
      return;
    }

    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = (reason: unknown) => {
      fail(reason);
      controller.abort(reason);
    };
    const onAbort = () => cancel(signal?.reason ?? new DOMException("AI request cancelled", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new Error(`AI provider timed out after ${timeoutMs}ms. Retry or switch to another model.`);
        error.name = "TimeoutError";
        cancel(error);
      }, timeoutMs);
    }

    Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return fn(controller.signal);
    }).then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }, fail);
  });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("AI request cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
