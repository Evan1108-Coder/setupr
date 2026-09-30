import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp } from "ink";
import { useSafeInput as useInput } from "../terminalInput.js";
import { collectContext } from "../../context/collector.js";
import { SETUPR_VERSION } from "../../version.js";
import { createProjectEngine } from "../../core/engine.js";
import { handleDirectorInput } from "../../ai/director.js";
import { contextToDSL } from "../../ai/dsl.js";
import { sanitizeForAI } from "../../ai/directorContext.js";
import { scanProject } from "../../scanner/index.js";
import { loadEnvEditorState } from "../../env/index.js";
import { type ChatSessionStatus, deleteChatSession, hydrateChatSession, saveChatSession } from "../../state/chatSession.js";
import type { AgentPrompt, AppMessage, AppStore, LogEntry, NoticeInfo } from "../../state/store.js";
import { ChatInput } from "../components/ChatInput.js";
import { Panel } from "../components/Panel.js";
import { PromptCard } from "../components/PromptCard.js";
import { TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall } from "../components/TuiFrame.js";
import { Timeline, type TimelineEvent } from "../components/Timeline.js";
import { useFocusNavigation, type FocusBounds, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useAppStore } from "../hooks/useStore.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { useAiRequest } from "../hooks/useAiRequest.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";

interface ChatLayoutProps {
  cwd: string;
  store: AppStore;
  initialMessage?: string;
  startNew?: boolean;
  resume?: boolean;
}

interface ChatLayoutModel {
  stacked: boolean;
  width: number;
  height: number;
  leftWidth: number;
  rightWidth: number;
  bodyHeight: number;
  planHeight: number;
  statusHeight: number;
  inputMaxLines: number;
  inputHeight: number;
  transcriptHeight: number;
  inputBounds: FocusBounds;
}

export function ChatLayout({ cwd, store, initialMessage, startNew = false }: ChatLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildChatLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildChatFocusItems(layout), [layout]), initialId: "input", onQuit: () => exit() });

  const messages = useAppStore(store, (s) => s.messages);
  const logs = useAppStore(store, (s) => s.logs);
  const steps = useAppStore(store, (s) => s.steps);
  const scan = useAppStore(store, (s) => s.scan);
  const context = useAppStore(store, (s) => s.context);
  const pendingPrompt = useAppStore(store, (s) => s.pendingPrompt);
  const notices = useAppStore(store, (s) => s.notices);
  const isRunning = useAppStore(store, (s) => s.isRunning);
  const projectName = useAppStore(store, (s) => s.projectName);
  const envVars = useAppStore(store, (s) => s.envVars);
  const services = useAppStore(store, (s) => s.services);

  const [status, setStatus] = useState<ChatSessionStatus>("idle");
  const [ready, setReady] = useState(false);
  const initialSent = useRef(false);

  const persist = useCallback(async (nextStatus: ChatSessionStatus = status, action?: string) => {
    await saveChatSession(cwd, store, { status: nextStatus, lastAction: action }).catch(() => undefined);
  }, [cwd, status, store]);
  const ai = useAiRequest({
    onError: (error) => {
      setStatus("failed");
      store.getState().setRunning(false);
      store.getState().addMessage({ role: "assistant", content: `AI request failed: ${error instanceof Error ? sanitizeForAI(error.message) : "unknown error"}. You can send your message again.` });
      void persist("failed", "chat.error");
    },
    onCancel: () => {
      setStatus("paused");
      store.getState().setRunning(false);
      store.getState().addMessage({ role: "system", content: "AI request cancelled. Send a new message, or press Ctrl+R to return to idle." });
      void persist("paused", "chat.pause");
    },
  });

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      if (startNew) {
        await deleteChatSession(cwd).catch(() => undefined);
      } else {
        const restored = await hydrateChatSession(cwd, store).catch(() => null);
        if (restored?.isRunning) {
          store.getState().setRunning(false);
          store.getState().addMessage({ role: "system", content: "The previous chat ended during a request. No request is running now; send your message again to retry." });
        }
      }

      const existingScan = store.getState().scan || await scanProject(cwd);
      if (cancelled) return;
      store.getState().setScan(existingScan);

      const projectContext = store.getState().context || await collectContext(cwd, existingScan);
      if (cancelled) return;
      store.getState().setContext(projectContext);
      const env = await loadEnvEditorState(cwd);
      if (cancelled) return;
      store.getState().setEnvVars(env.entries.map(entry => ({
        key: entry.key,
        value: entry.status === "filled" || entry.status === "extra" ? entry.value : "",
        status: entry.status === "filled" || entry.status === "extra" ? "auto" : "pending",
        source: entry.status === "filled" || entry.status === "extra" ? ".env" : undefined,
      })));
      store.getState().setServices(existingScan.services.map(name => ({ name, status: "pending" })));

      const engine = createProjectEngine({ cwd, command: "chat", mode: "tui" });
      const [history, checkpoints] = await Promise.all([
        engine.history(20),
        engine.checkpoints(),
      ]);
      if (cancelled) return;
      if (store.getState().steps.length === 0) {
        if (checkpoints.setup?.steps?.length) store.getState().setSteps(checkpoints.setup.steps);
        else if (checkpoints.agent?.steps?.length) store.getState().setSteps(checkpoints.agent.steps);
      }
      for (const event of history.slice(-4)) {
        store.getState().addLog({
          type: event.type.includes("error") ? "warning" : "info",
          content: `${event.type}: ${event.message || ""}`,
        });
      }
      if (store.getState().messages.length === 0) {
        store.getState().addMessage({
          role: "system",
          content: "Chat session ready. Ask about this project, steer a plan, paste env values, or ask me to inspect status.",
        });
      }
      setReady(true);
      await saveChatSession(cwd, store, { status: "idle", lastAction: "chat.boot" }).catch(() => undefined);
    }
    void boot().catch((error: unknown) => {
      if (cancelled) return;
      setStatus("failed");
      store.getState().addMessage({ role: "system", content: `Could not load project context: ${error instanceof Error ? sanitizeForAI(error.message) : "unknown error"}. Exit and retry after checking the project directory.` });
    });
    return () => {
      cancelled = true;
    };
  }, [cwd, startNew, store]);

  useEffect(() => {
    setStatus(statusFromPromptOrRunning(pendingPrompt, isRunning, status));
  }, [pendingPrompt, isRunning]);

  useInput((input, key) => {
    if (key.ctrl && input === "r" && status === "paused") {
      setStatus("idle");
      store.getState().addMessage({ role: "system", content: "Resumed. Send the next message or steering instruction." });
      void persist("idle", "chat.resume");
    }
  });

  const submitChat = useCallback(async (text: string, meta?: { steer?: boolean; source?: string }) => {
    if (!text.trim()) return;
    await ai.run(async (request) => {
      const role: AppMessage["role"] = meta?.steer ? "steer" : "user";
      store.getState().addMessage({ role, content: sanitizeForAI(text) });

      const ambiguousPrompt = maybeCreateAmbiguityPrompt(text, store);
      if (ambiguousPrompt) {
        store.getState().setPendingPrompt(ambiguousPrompt);
        setStatus("awaiting-choice");
        await persist("awaiting-choice", "prompt.ask");
        return;
      }

      const state = store.getState();
      const activeScan = state.scan || scan;
      const activeContext = state.context || context;
      if (!activeScan || !activeContext) {
        store.getState().addMessage({
          role: "assistant",
          content: "I am still loading project context. Try again in a moment.",
        });
        await persist("idle", "chat.context.missing");
        return;
      }

      setStatus("thinking");
      store.getState().setRunning(true);
      await persist("thinking", meta?.steer ? "chat.steer" : "chat.message");
      try {
        request.signal.throwIfAborted();
        const result = await handleDirectorInput({
          text,
          cwd,
          scan: activeScan,
          contextDSL: contextToDSL(activeContext),
          store,
          ...request,
        });
        request.signal.throwIfAborted();
        const nextStatus = statusFromPromptOrRunning(store.getState().pendingPrompt, false, "idle");
        store.getState().setRunning(false);
        setStatus(nextStatus);
        await persist(nextStatus, result.action);
      } finally {
        if (!request.signal.aborted) store.getState().setRunning(false);
      }
    });
  }, [context, cwd, persist, scan, store, ai.run]);

  const handlePromptSubmit = useCallback((value: string, option?: { id: string }) => {
    const prompt = store.getState().pendingPrompt;
    if (!prompt) return;
    store.getState().answerPrompt({ promptId: prompt.id, value: sanitizeForAI(value), optionId: option?.id });
    if (prompt.id === "chat-ambiguous-model") {
      store.getState().addMessage({
        role: "assistant",
        content: option?.id === "setupr-ai-model"
          ? "Got it. Tell me the Setupr AI model ID to use, or say “switch to cheapest model.”"
          : option?.id === "project-model"
            ? "Got it. I will treat model changes as project code/config work. Tell me the file, env var, or framework model you want changed."
            : `Got it. I will interpret this as: ${sanitizeForAI(value)}`,
      });
    } else {
      store.getState().addMessage({
        role: "assistant",
        content: option ? `Got it. I selected "${sanitizeForAI(option.id)}".` : "Got it. I will use that answer.",
      });
    }
    setStatus("idle");
    void persist("idle", "prompt.answer");
  }, [persist, store]);

  useEffect(() => {
    if (!ready || initialSent.current || !initialMessage?.trim()) return;
    initialSent.current = true;
    void submitChat(initialMessage.trim(), { steer: false, source: "initial" });
  }, [initialMessage, ready, submitChat]);

  const events = useMemo(() => buildChatEvents(messages, logs, notices), [logs, messages, notices]);

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr chat" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <Header cwd={cwd} projectName={projectName} status={status} ready={ready} width={terminal.width} />
      {layout.stacked ? (
        <StackedChat
          layout={layout}
          focus={focus.focusState}
          events={events}
          steps={steps}
          status={status}
          scan={scan}
          envVars={envVars}
          services={services}
          pendingPrompt={pendingPrompt}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={submitChat}
          chatProgress={ai.pending ? ai.label : undefined}
          onPromptSubmit={handlePromptSubmit}
        />
      ) : (
        <WideChat
          layout={layout}
          focus={focus.focusState}
          events={events}
          steps={steps}
          status={status}
          scan={scan}
          envVars={envVars}
          services={services}
          pendingPrompt={pendingPrompt}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={submitChat}
          chatProgress={ai.pending ? ai.label : undefined}
          onPromptSubmit={handlePromptSubmit}
        />
      )}
      <Footer status={status} width={terminal.width} />
    </Box>
  );
}

export function buildChatLayout(width: number, height: number): ChatLayoutModel {
  const stacked = width < 96 || height < 22;
  const bodyHeight = Math.max(8, height - 2);
  const gap = tuiLayout.panelGap;
  const pairTotal = stacked ? width : Math.max(1, width - gap);
  const rightWidth = stacked ? width : clamp(Math.floor(width * 0.26), 28, 42);
  const leftWidth = stacked ? width : pairTotal - rightWidth;
  const sideHeight = stacked ? bodyHeight : Math.max(8, bodyHeight - gap);
  const planHeight = stacked ? clamp(Math.floor(bodyHeight * 0.24), 4, 8) : clamp(Math.floor(sideHeight * 0.52), 8, sideHeight - 6);
  const statusHeight = stacked ? clamp(Math.floor(bodyHeight * 0.2), 4, 7) : sideHeight - planHeight;
  const inputMaxLines = Math.max(1, Math.min(6, Math.floor(bodyHeight / 5)));
  const inputHeight = inputMaxLines + 2;
  const transcriptHeight = stacked
    ? Math.max(4, bodyHeight - inputHeight - planHeight - statusHeight)
    : Math.max(4, bodyHeight - inputHeight);
  const inputY = stacked
    ? Math.max(4, height - inputHeight)
    : Math.max(4, 2 + transcriptHeight);
  return {
    stacked,
    width,
    height,
    leftWidth,
    rightWidth,
    bodyHeight,
    planHeight,
    statusHeight,
    inputMaxLines,
    inputHeight,
    transcriptHeight,
    inputBounds: { x: 3, y: inputY, width: Math.max(8, leftWidth - 6), height: inputHeight },
  };
}

export function buildChatFocusItems(layout: ChatLayoutModel): FocusItem[] {
  if (layout.stacked) {
    return [
      { id: "conversation", row: 0, column: 0, redirectTo: "input", bounds: { x: 1, y: 2, width: layout.width, height: layout.transcriptHeight } },
      { id: "input", row: 1, column: 0, parentIds: ["conversation"], bounds: layout.inputBounds },
      { id: "plan", row: 2, column: 0, bounds: { x: 1, y: 2 + layout.transcriptHeight + layout.inputHeight, width: layout.width, height: layout.planHeight } },
      { id: "status", row: 3, column: 0, bounds: { x: 1, y: 2 + layout.transcriptHeight + layout.inputHeight + layout.planHeight, width: layout.width, height: layout.statusHeight } },
    ];
  }
  return [
    { id: "conversation", row: 0, column: 0, redirectTo: "input", bounds: { x: 1, y: 2, width: layout.leftWidth, height: layout.bodyHeight } },
    { id: "input", row: 1, column: 0, parentIds: ["conversation"], bounds: layout.inputBounds },
    { id: "plan", row: 0, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: 2, width: layout.rightWidth, height: layout.planHeight } },
    { id: "status", row: 1, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: 2 + layout.planHeight + tuiLayout.panelGap, width: layout.rightWidth, height: layout.statusHeight } },
  ];
}

function Header({ cwd, projectName, status, ready, width }: { cwd: string; projectName: string; status: ChatSessionStatus; ready: boolean; width: number }) {
  const statusText = ready || status === "failed" ? status : "loading";
  return (
    <TuiHeader
      command="setupr chat"
      title={projectName}
      cwd={cwd}
      status={statusText}
      statusColor={statusColor(status)}
      right={statusText}
      width={width}
    />
  );
}

function WideChat(props: ChatViewProps) {
  return (
    <Box flexDirection="row" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <ConversationPanel {...props} width={props.layout.leftWidth} />
      <Box flexDirection="column" width={props.layout.rightWidth} height="100%" gap={tuiLayout.panelGap}>
        <PlanPanel steps={props.steps} focusState={props.focus("plan")} height={props.layout.planHeight} />
        <StatusPanel {...props} height={props.layout.statusHeight} />
      </Box>
    </Box>
  );
}

function StackedChat(props: ChatViewProps) {
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight}>
      <ConversationPanel {...props} width={props.layout.width} />
      <PlanPanel steps={props.steps} focusState={props.focus("plan")} height={props.layout.planHeight} />
      <StatusPanel {...props} height={props.layout.statusHeight} />
    </Box>
  );
}

function ConversationPanel({
  layout,
  focus,
  events,
  pendingPrompt,
  inputActive,
  inputBounds,
  onChat,
  onPromptSubmit,
  chatProgress,
  width,
  status,
}: ChatViewProps & { width: number }) {
  const promptActive = Boolean(pendingPrompt && focus("input") === "focused");
  const disabled = status === "thinking" || status === "running";
  const maxItems = Math.max(1, layout.transcriptHeight - (pendingPrompt ? layout.inputMaxLines + 5 : layout.inputMaxLines + 2));
  return (
    <Panel title="CONVERSATION" focusState={focus("conversation")} width={width} height={layout.stacked ? layout.transcriptHeight + layout.inputHeight : "100%"}>
      <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0} overflow="hidden">
          <Timeline fill events={events} maxItems={maxItems} width={typeof width === "number" ? width - 4 : 80} active={focus("conversation") !== undefined} emptyText="No chat messages yet." />
        </Box>
        <Box flexShrink={0}>
          {pendingPrompt ? (
            <PromptCard
              title={pendingPrompt.title}
              message={pendingPrompt.message}
              options={pendingPrompt.options}
              includeOther={pendingPrompt.includeOther}
              otherLabel={pendingPrompt.otherLabel}
              sensitiveInput={pendingPrompt.sensitive || pendingPrompt.type === "secret"}
              placeholder={pendingPrompt.placeholder || "Type another answer..."}
              active={promptActive}
              focusState={focus("input")}
              onSubmit={onPromptSubmit}
              width={Math.max(12, Number(width) - 4)}
              maxInputLines={layout.inputMaxLines}
              scrollBounds={inputBounds}
            />
          ) : (
            <ChatInput
              active={inputActive}
              focusState={focus("input")}
              onSubmit={onChat}
              placeholder="Message Setupr, or /steer skip tests..."
              width={Math.max(12, Number(width) - 4)}
              maxLines={layout.inputMaxLines}
              scrollBounds={inputBounds}
              disabled={disabled}
              disabledText={chatProgress}
            />
          )}
        </Box>
      </Box>
    </Panel>
  );
}

function PlanPanel({ steps, focusState, height }: { steps: Array<{ id: string; label: string; status: string }>; focusState?: "focused" | "ancestor"; height: number }) {
  return (
    <Panel title="PLAN" focusState={focusState} height={height}>
      {steps.length === 0 ? (
        <Text color={colors.textDim}>No active plan yet.</Text>
      ) : (
        steps.slice(0, Math.max(1, height - 3)).map((step) => (
          <Text key={step.id} color={stepColor(step.status)} wrap="truncate">
            {stepIcon(step.status)} {step.label}
          </Text>
        ))
      )}
      {steps.length > height - 3 && <Text color={colors.textDim}>… {steps.length - (height - 3)} more</Text>}
    </Panel>
  );
}

function StatusPanel({ focus, status, scan, envVars, services, height }: ChatViewProps & { height: number }) {
  const missingEnv = envVars.filter((item) => item.status === "pending").length;
  const rows = [
    { label: "State", value: status, color: statusColor(status) },
    { label: "Stack", value: [scan?.framework, scan?.language].filter(Boolean).join(" / ") || "unknown" },
    { label: "PM", value: scan?.packageManager || "none" },
    { label: "Env", value: envVars.length ? `${envVars.length - missingEnv}/${envVars.length} filled` : "none", color: missingEnv > 0 ? colors.warning : undefined },
    { label: "Services", value: services.length ? services.map((item) => item.name).slice(0, 2).join(", ") : "none" },
  ];
  const visibleRows = rows.slice(0, Math.max(1, height - 3));
  return (
    <Panel title="SESSION" focusState={focus("status")} height={height}>
      {visibleRows.map((row) => (
        <KV key={row.label} label={row.label} value={row.value} color={row.color} />
      ))}
    </Panel>
  );
}

function Footer({ status, width }: { status: ChatSessionStatus; width: number }) {
  const text = status === "thinking" || status === "running"
    ? "Esc cancel AI · Tab panels · q quit outside input"
    : "Enter send · Ctrl+Enter or /steer steer · Tab panels · ↑/↓ navigate · q quit outside input";
  return (
    <TuiFooter width={width} left={width < 90 ? text.replace(" · ↑/↓ navigate", "") : text} right={`v${SETUPR_VERSION}`} />
  );
}

function maybeCreateAmbiguityPrompt(text: string, store: AppStore): AgentPrompt | null {
  if (!/\b(change|switch|set|use)\b.{0,24}\bmodel\b|\bmodel\b.{0,24}\b(change|switch|set|use)\b/i.test(text)) return null;
  if (/\b(gpt|claude|gemini|llama|minimax|kimi|moonshot|openai\/|anthropic\/|google\/)[A-Za-z0-9_.:/-]*/i.test(text)) return null;
  if (store.getState().pendingPrompt) return null;
  return {
    id: "chat-ambiguous-model",
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
  };
}

function statusFromPromptOrRunning(prompt: AgentPrompt | null, running: boolean, fallback: ChatSessionStatus): ChatSessionStatus {
  if (prompt?.type === "choice" || prompt?.type === "confirm") return "awaiting-choice";
  if (prompt?.type === "secret") return "awaiting-secret";
  if (prompt?.type === "input") return "awaiting-text";
  if (running) return "running";
  if (fallback === "paused" || fallback === "failed") return fallback;
  return "idle";
}

function buildChatEvents(messages: AppMessage[], logs: LogEntry[], notices: NoticeInfo[]): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...messages.map((message) => ({
      id: `message-${message.id}`,
      kind: message.role,
      content: message.content,
      timestamp: message.timestamp,
      tone: message.role === "system" ? "muted" as const : undefined,
      detail: message.level ? `AI level: ${message.level}${message.cost ? ` · cost ${message.cost.toFixed(6)}` : ""}` : undefined,
    })),
    ...logs.map((log) => ({
      id: `log-${log.id}`,
      kind: "log" as const,
      content: log.content,
      timestamp: log.timestamp,
      tone: log.type === "error" ? "error" as const : log.type === "warning" ? "warning" as const : log.type === "success" ? "success" as const : "info" as const,
      title: log.type === "command" ? "Command" : undefined,
    })),
    ...notices.map((notice, index) => ({
      id: `notice-${index}`,
      kind: "notice" as const,
      content: notice.message,
      tone: notice.type === "error" ? "error" as const : notice.type === "warning" ? "warning" as const : "info" as const,
    })),
  ];
  return events.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

function KV({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Box justifyContent="space-between" width="100%" minWidth={0}>
      <Box flexShrink={0} marginRight={1}>
        <Text color={colors.label}>{label}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={color || colors.value} wrap="truncate">{value}</Text>
      </Box>
    </Box>
  );
}

function stepIcon(status: string): string {
  if (status === "done") return icons.check;
  if (status === "failed") return icons.cross;
  if (status === "running") return icons.arrowRight;
  if (status === "skipped") return icons.circle;
  return icons.circle;
}

function stepColor(status: string): string {
  if (status === "done") return colors.success;
  if (status === "failed") return colors.error;
  if (status === "running") return colors.accent;
  if (status === "skipped") return colors.textDim;
  return colors.text;
}

function statusColor(status: ChatSessionStatus): string {
  if (status === "failed") return colors.error;
  if (status === "paused") return colors.warning;
  if (status.startsWith("awaiting")) return colors.accent;
  if (status === "thinking" || status === "running") return colors.primary;
  return colors.success;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

interface ChatViewProps {
  layout: ChatLayoutModel;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  events: TimelineEvent[];
  steps: Array<{ id: string; label: string; status: string }>;
  status: ChatSessionStatus;
  scan: { framework?: string | null; language?: string | null; packageManager?: string | null } | null;
  envVars: Array<{ status: string }>;
  services: Array<{ name: string }>;
  pendingPrompt: AgentPrompt | null;
  inputActive: boolean;
  inputBounds?: FocusBounds;
  onChat: (text: string, meta?: { steer?: boolean }) => void;
  chatProgress?: string;
  onPromptSubmit: (value: string, option?: { id: string }) => void;
}
