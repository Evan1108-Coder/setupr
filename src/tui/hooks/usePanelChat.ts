import { useCallback, useMemo, useRef, useState } from "react";
import type { ChatMessage } from "../../ai/client.js";
import { sanitizeForAI } from "../../ai/directorContext.js";
import { scanResultToDSL } from "../../ai/dsl.js";
import { intelligentResponse } from "../../ai/intelligence.js";
import type { ScanResult } from "../../scanner/index.js";
import type { TimelineEvent } from "../components/Timeline.js";
import { createTerminalControlInputStripper } from "../terminalInput.js";
import { useAiRequest } from "./useAiRequest.js";

const HISTORY_LIMIT = 16;
const MESSAGE_LIMIT = 4000;
const sanitize = (text: string) => sanitizeForAI(createTerminalControlInputStripper().strip(text));

export function usePanelChat(options: {
  scan: ScanResult;
  command: "doctor" | "start" | "update";
  context: string;
}) {
  const { scan, command, context } = options;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const history = useRef<ChatMessage[]>([]);
  const chatMessages = useMemo(() => messages.map(({ role, content }) => `${role === "user" ? "You" : "AI"} \u2192 ${content}`), [messages]);
  const chatEvents = useMemo<TimelineEvent[]>(() => messages.map(({ role, content }, index) => ({
    id: `${command}-chat-${index}`, kind: role, content,
  })), [command, messages]);

  const append = useCallback((role: ChatMessage["role"], text: string) => {
    const content = sanitize(text);
    if (role !== "system") {
      history.current = [...history.current, { role, content: content.slice(-MESSAGE_LIMIT) }].slice(-HISTORY_LIMIT);
    }
    setMessages((previous) => [...previous, { role, content }]);
  }, []);

  const { run, cancel, pending, label } = useAiRequest({
    onError: (error) => append("system", `AI request failed: ${error instanceof Error ? error.message : "Unknown error"}. You can retry your message.`),
    onCancel: () => append("system", "AI reply cancelled. You can send another message."),
  });

  const handleChat = useCallback(async (text: string) => {
    const content = sanitize(text).trim();
    if (!content) return;
    await run(async ({ signal, onProgress }) => {
      // Capture prior turns before adding this question; intelligentResponse
      // appends the current question itself. Refs cover coalesced submissions.
      const messages = history.current.map((message) => ({ ...message }));
      append("user", content);
      const result = await intelligentResponse(
        content,
        scan,
        sanitize(`[${command.toUpperCase()}] ${scanResultToDSL(scan)}`),
        { messages, directorContext: sanitize(context), signal, onProgress: (message) => onProgress(sanitize(message)) }
      );
      signal.throwIfAborted();
      append("assistant", result.response);
    });
  }, [append, command, context, run, scan]);

  return { chatMessages, chatEvents, handleChat, pending, label: sanitize(label), cancel };
}
