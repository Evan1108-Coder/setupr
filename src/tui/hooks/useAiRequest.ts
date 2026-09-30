import { useCallback, useEffect, useRef, useState } from "react";
import { useSafeInput as useInput } from "../terminalInput.js";

export interface AiRequestContext {
  signal: AbortSignal;
  onProgress: (message: string) => void;
}

// One request per screen. A cancelled request cannot publish into a newer turn.
export function useAiRequest(options: { onError: (error: unknown) => void; onCancel?: () => void }) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const active = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState("");
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  useEffect(() => () => {
    const controller = active.current;
    active.current = null;
    controller?.abort();
  }, []);

  const cancel = useCallback(() => {
    const controller = active.current;
    if (!controller) return;
    active.current = null;
    controller.abort();
    setPending(false);
    setProgress("");
    callbacks.current.onCancel?.();
  }, []);

  useInput((_input, key) => { if (key.escape) cancel(); });

  const run = useCallback(async <T,>(task: (context: AiRequestContext) => Promise<T>): Promise<T | undefined> => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setPending(true);
    setProgress("Preparing project context");
    setElapsed(0);
    try {
      const result = await task({
        signal: controller.signal,
        onProgress: (message) => { if (active.current === controller) setProgress(message); },
      });
      return active.current === controller ? result : undefined;
    } catch (error) {
      if (active.current === controller && !controller.signal.aborted) callbacks.current.onError(error);
      return undefined;
    } finally {
      if (active.current === controller) {
        active.current = null;
        setPending(false);
        setProgress("");
      }
    }
  }, []);

  return { run, cancel, pending, progress, elapsed, label: `AI: ${progress} (${elapsed}s) | Esc cancel` };
}
