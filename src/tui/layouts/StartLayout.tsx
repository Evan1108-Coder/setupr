import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { classifyCommandFailure, createSetuprError, sanitizeSecret, type SetuprError } from "../../errors/index.js";
import { runCommand } from "../../executor/index.js";
import type { ScanResult } from "../../scanner/index.js";
import { ChatInput } from "../components/ChatInput.js";
import { Panel } from "../components/Panel.js";
import { Spinner } from "../components/Spinner.js";
import { Timeline, type TimelineEvent } from "../components/Timeline.js";
import { KVRow, TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall, statusColor } from "../components/TuiFrame.js";
import { useFocusNavigation, type FocusBounds, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { usePanelChat } from "../hooks/usePanelChat.js";
import { hasProjectSignals } from "../projectSignals.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";

interface StartLayoutProps {
  scan: ScanResult;
  cwd: string;
}

interface StartLayoutGeometry {
  width: number;
  height: number;
  stacked: boolean;
  bodyHeight: number;
  processWidth: number;
  logWidth: number;
  sideWidth: number;
  logHeight: number;
  inputMaxLines: number;
  inputHeight: number;
  inputBounds: FocusBounds;
}

type StartStatus = "detecting" | "running" | "failed" | "stopped";

export function StartLayout({ scan, cwd }: StartLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildStartLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildStartFocusItems(layout), [layout]), onQuit: () => exit() });
  const [status, setStatus] = useState<StartStatus>("detecting");
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<SetuprError | null>(null);
  const [output, setOutput] = useState<string[]>([]);
  const { chatEvents, handleChat, pending: aiPending, label: aiLabel } = usePanelChat({
    scan,
    command: "start",
    context: `Project process status: ${status}\nCommand: ${command || "none"}\nRecent output: ${output.slice(-8).join("\n")}`,
  });
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const noProject = !hasProjectSignals(scan);

  useEffect(() => {
    const abortController = new AbortController();
    const startCmd = noProject ? null : detectStartCommand(scan);
    if (startCmd) {
      setCommand(startCmd);
      setError(null);
      setStartedAt(Date.now());
      setStatus("running");
      runCommand(startCmd, cwd, (line) => {
        setOutput((prev) => [...prev.slice(-160), sanitizeSecret(line)]);
      }, abortController.signal).then((result) => {
        if (!abortController.signal.aborted) {
          if (result.exitCode !== 0) {
            setError(classifyCommandFailure({
              command: startCmd,
              cwd,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              stepLabel: "Start project",
              stepType: "script",
            }));
            setStatus("failed");
          } else {
            setStatus("stopped");
          }
        }
      });
    } else {
      setError(createSetuprError({
        code: noProject ? "NO_PROJECT_DETECTED" : "MISSING_SCRIPT",
        command: "start",
        cwd,
        details: noProject
          ? ["No package.json, pyproject.toml, Cargo.toml, go.mod, or similar file was detected."]
          : ["No dev, start, serve, develop, or watch script was found."],
      }));
      setStatus("failed");
    }
    return () => {
      abortController.abort();
    };
  }, []);

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr start" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader
        command="setupr start"
        cwd={cwd}
        stack={buildStack(scan)}
        status={status === "running" ? "LIVE" : status}
        statusColor={status === "running" ? colors.success : status === "failed" ? colors.error : colors.textDim}
        right={`${status === "running" ? "● live" : status} ${command ? `· ${command}` : ""}`}
        width={terminal.width}
      />

      {layout.stacked ? (
        <StackedStart
          layout={layout}
          scan={scan}
          status={status}
          command={command}
          error={error}
          output={output}
          chatEvents={chatEvents}
          aiPending={aiPending}
          aiLabel={aiLabel}
          startedAt={startedAt}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={handleChat}
        />
      ) : (
        <WideStart
          layout={layout}
          scan={scan}
          status={status}
          command={command}
          error={error}
          output={output}
          chatEvents={chatEvents}
          aiPending={aiPending}
          aiLabel={aiLabel}
          startedAt={startedAt}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={handleChat}
        />
      )}

      <TuiFooter
        width={terminal.width}
        left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Enter ask · q quit outside input"
        right={command || scan.packageManager || undefined}
      />
    </Box>
  );
}

function WideStart(props: StartViewProps) {
  const sideUsableHeight = Math.max(8, props.layout.bodyHeight - tuiLayout.panelGap * 2);
  const currentHeight = Math.max(8, Math.floor(sideUsableHeight * 0.38));
  const policyHeight = Math.max(7, Math.floor(sideUsableHeight * 0.28));
  return (
    <Box flexDirection="row" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Panel title="Processes" focusState={props.focus("processes")} width={props.layout.processWidth} height="100%">
        <ProcessRail scan={props.scan} command={props.command} status={props.status} />
      </Panel>
      <LogPanel {...props} width={props.layout.logWidth} height="100%" />
      <Box flexDirection="column" width={props.layout.sideWidth} height="100%" gap={tuiLayout.panelGap}>
        <Panel title="Current Process" focusState={props.focus("current")} width="100%" height={currentHeight}>
          <CurrentProcessPanel {...props} />
        </Panel>
        <Panel title="Restart Policy" focusState={props.focus("policy")} width="100%" height={policyHeight}>
          <RestartPolicyPanel status={props.status} />
        </Panel>
        <Panel title="Crash Info" focusState={props.focus("crash")} width="100%" flexGrow={1} minHeight={6}>
          <CrashPanel error={props.error} status={props.status} />
        </Panel>
      </Box>
    </Box>
  );
}

function StackedStart(props: StartViewProps) {
  const sideHeight = Math.max(7, props.layout.bodyHeight - props.layout.logHeight - tuiLayout.panelGap);
  const processWidth = Math.floor((props.layout.width - tuiLayout.panelGap) * 0.45);
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <LogPanel {...props} width={props.layout.width} height={props.layout.logHeight} />
      <Box flexDirection="row" width="100%" height={sideHeight} gap={tuiLayout.panelGap}>
        <Panel title="Processes" focusState={props.focus("processes")} width={processWidth} height="100%">
          <ProcessRail scan={props.scan} command={props.command} status={props.status} compact />
        </Panel>
        <Panel title="Current" focusState={props.focus("current")} width={props.layout.width - processWidth - tuiLayout.panelGap} height="100%">
          <CurrentProcessPanel {...props} compact />
        </Panel>
      </Box>
    </Box>
  );
}

function LogPanel({
  layout,
  status,
  command,
  error,
  output,
  chatEvents,
  aiPending,
  aiLabel,
  focus,
  inputActive,
  inputBounds,
  onChat,
  width,
  height,
}: StartViewProps & { width: number; height: number | string }) {
  const chatRows = chatEvents.length ? Math.max(1, Math.min(8, Math.floor((layout.logHeight - layout.inputHeight - 3) / 2))) : 0;
  const outputLimit = Math.max(1, layout.logHeight - layout.inputMaxLines - 6 - chatRows);
  return (
    <Panel title="Log Stream" focusState={focus("logs")} width={width} height={height}>
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          {status === "detecting" && <Spinner label="Detecting start command..." />}
          {status === "running" && (
            <>
              <Text color={colors.success} wrap="truncate">{icons.dot} Running: <Text color={colors.accent}>{command}</Text></Text>
              {output.length === 0 && (
                <>
                  <Text color={colors.textDim}>waiting for first process output…</Text>
                  <Text color={colors.label} wrap="truncate">cwd <Text color={colors.value}>{cwdForLogPlaceholder()}</Text></Text>
                  <Text color={colors.label}>logs <Text color={colors.textDim}>live stream will appear here</Text></Text>
                </>
              )}
              {output.slice(-outputLimit).map((line, index) => (
                <Text key={`${line}-${index}`} color={logLineColor(line)} wrap="truncate">{line}</Text>
              ))}
            </>
          )}
          {status === "failed" && (
            <Box flexDirection="column">
              <Text color={colors.error}>{icons.cross} {error?.title || (command ? `Command failed: ${command}` : "No start command found")}</Text>
              {error && <Text color={colors.textDim}>{error.code}</Text>}
              {error && <Text color={colors.text}>{error.explanation}</Text>}
              {error?.details?.slice(0, 3).map((detail, index) => (
                <Text key={`detail-${index}`} color={colors.textDim} wrap="truncate">  {detail}</Text>
              ))}
              {output.slice(-Math.min(outputLimit, 8)).map((line, index) => (
                <Text key={`${line}-${index}`} color={colors.error} wrap="truncate">{line}</Text>
              ))}
            </Box>
          )}
          {status === "stopped" && <Text color={colors.warning}>{icons.warning} Process exited</Text>}
        </Box>
        {chatRows > 0 && (
          <Box height={chatRows} flexShrink={0} overflow="hidden">
            <Timeline events={chatEvents} maxItems={chatRows} width={Math.max(1, width - 4)} showTime={false} active={inputActive} />
          </Box>
        )}
        <ChatInput
          active={inputActive}
          disabled={aiPending}
          disabledText={aiLabel}
          focusState={focus("input")}
          onSubmit={onChat}
          placeholder="Command (start|stop|restart|logs|follow) or ask about the process..."
          width={Math.max(12, width - 4)}
          maxLines={layout.inputMaxLines}
          scrollBounds={inputBounds}
        />
      </Box>
    </Panel>
  );
}

function ProcessRail({ scan, command, status, compact = false }: { scan: ScanResult; command: string | null; status: StartStatus; compact?: boolean }) {
  const rows = [
    { name: command ? "web" : "project", detail: command || "no start command", color: statusColor(status) },
    ...Object.entries(scan.scripts).filter(([name]) => /^(dev|start|serve|watch|worker|api|db)/.test(name)).slice(0, compact ? 4 : 8).map(([name, value]) => ({
      name,
      detail: value,
      color: command?.includes(name) ? colors.accent : colors.textDim,
    })),
    ...scan.services.slice(0, compact ? 2 : 5).map((service) => ({ name: service, detail: "detected, not monitored", color: colors.textDim })),
  ];
  return (
    <Box flexDirection="column">
      {rows.length === 0 ? <Text color={colors.textDim}>No scripts detected.</Text> : rows.map((row) => (
        <Text key={`${row.name}-${row.detail}`} color={row.color} wrap="truncate">
          {row.name === "web" && status === "running" ? icons.arrowRight : icons.dot} {row.name} <Text color={colors.textDim}>{row.detail}</Text>
        </Text>
      ))}
      {!compact && <Text color={colors.textDim}>{status === "running" ? "Command active; health unverified" : status}</Text>}
    </Box>
  );
}

function CurrentProcessPanel({ scan, command, status, output, startedAt, compact = false }: StartViewProps & { compact?: boolean }) {
  return (
    <Box flexDirection="column">
      <KVRow label="Name" value="web" />
      <KVRow label="Command" value={command || "none"} color={command ? colors.text : colors.warning} />
      {!compact && <KVRow label="PM" value={scan.packageManager || "none"} />}
      <KVRow label="Status" value={status} color={statusColor(status)} />
      <KVRow label="Output" value={`${output.length} lines`} />
      <KVRow label="Uptime" value={startedAt && status === "running" ? elapsedText(startedAt) : "—"} color={startedAt && status === "running" ? colors.success : colors.textDim} />
    </Box>
  );
}

function RestartPolicyPanel({ status }: { status: StartStatus }) {
  return (
    <Box flexDirection="column">
      <KVRow label="Policy" value="manual" color={colors.text} />
      <KVRow label="Auto retry" value="off" color={colors.textDim} />
      <Text color={colors.textDim} wrap="wrap">{status === "failed" ? "Review the failure before restarting." : "This foreground session does not automatically restart commands."}</Text>
    </Box>
  );
}

function CrashPanel({ error, status }: { error: SetuprError | null; status: StartStatus }) {
  if (!error) {
    return (
      <Box flexDirection="column">
        <KVRow label="Crash count" value="0" color={colors.success} />
        <KVRow label="Last exit" value={status === "stopped" ? "clean exit" : "none"} />
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={colors.error} wrap="truncate">{error.code}</Text>
      <Text color={colors.text} wrap="truncate">{error.title}</Text>
      <Text color={colors.textDim} wrap="wrap">{error.explanation}</Text>
    </Box>
  );
}

export function buildStartLayout(width: number, height: number): StartLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 110 || bodyHeight < 20;
  const gap = tuiLayout.panelGap;
  const processWidth = stacked ? width : clamp(Math.floor(width * 0.18), 20, 32);
  const sideWidth = stacked ? width : clamp(Math.floor(width * 0.24), 28, 40);
  const logWidth = stacked ? width : Math.max(8, width - processWidth - sideWidth - gap * 2);
  const logHeight = stacked ? Math.max(8, bodyHeight - 8 - gap) : bodyHeight;
  const inputMaxLines = Math.max(1, Math.min(6, Math.floor(logHeight / 4)));
  const inputHeight = inputMaxLines + 2;
  const inputBounds = { x: stacked ? 3 : processWidth + gap + 3, y: Math.max(4, 2 + logHeight - inputHeight - 1), width: Math.max(8, logWidth - 6), height: inputHeight };
  return { width, height, stacked, bodyHeight, processWidth, logWidth, sideWidth, logHeight, inputMaxLines, inputHeight, inputBounds };
}

export function buildStartFocusItems(layout: StartLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    const sideHeight = Math.max(7, layout.bodyHeight - layout.logHeight - tuiLayout.panelGap);
    const procWidth = Math.floor((layout.width - tuiLayout.panelGap) * 0.45);
    return [
      { id: "logs", row: 0, column: 0, redirectTo: "input", bounds: { x: 1, y: 2, width: layout.width, height: layout.logHeight } },
      { id: "input", row: 1, column: 0, parentIds: ["logs"], bounds: layout.inputBounds },
      { id: "processes", row: 2, column: 0, bounds: { x: 1, y: 2 + layout.logHeight + tuiLayout.panelGap, width: procWidth, height: sideHeight } },
      { id: "current", row: 2, column: 1, bounds: { x: procWidth + tuiLayout.panelGap + 1, y: 2 + layout.logHeight + tuiLayout.panelGap, width: layout.width - procWidth - tuiLayout.panelGap, height: sideHeight } },
    ];
  }
  const sideX = layout.processWidth + layout.logWidth + tuiLayout.panelGap * 2 + 1;
  const sideUsableHeight = Math.max(8, layout.bodyHeight - tuiLayout.panelGap * 2);
  const currentHeight = Math.max(8, Math.floor(sideUsableHeight * 0.38));
  const policyHeight = Math.max(7, Math.floor(sideUsableHeight * 0.28));
  return [
    { id: "processes", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.processWidth, height: layout.bodyHeight } },
    { id: "logs", row: 0, column: 1, redirectTo: "input", bounds: { x: layout.processWidth + tuiLayout.panelGap + 1, y: 2, width: layout.logWidth, height: layout.bodyHeight } },
    { id: "input", row: 1, column: 1, parentIds: ["logs"], bounds: layout.inputBounds },
    { id: "current", row: 0, column: 2, bounds: { x: sideX, y: 2, width: layout.sideWidth, height: currentHeight } },
    { id: "policy", row: 1, column: 2, bounds: { x: sideX, y: 2 + currentHeight + tuiLayout.panelGap, width: layout.sideWidth, height: policyHeight } },
    { id: "crash", row: 2, column: 2, bounds: { x: sideX, y: 2 + currentHeight + policyHeight + tuiLayout.panelGap * 2, width: layout.sideWidth, height: layout.bodyHeight - currentHeight - policyHeight - tuiLayout.panelGap * 2 } },
  ];
}

interface StartViewProps {
  layout: StartLayoutGeometry;
  scan: ScanResult;
  status: StartStatus;
  command: string | null;
  error: SetuprError | null;
  output: string[];
  chatEvents: TimelineEvent[];
  aiPending: boolean;
  aiLabel: string;
  startedAt: number | null;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  inputActive: boolean;
  inputBounds?: FocusBounds;
  onChat: (text: string) => void;
}

function detectStartCommand(scan: ScanResult): string | null {
  const pm = scan.packageManager || "npm";
  if (scan.scripts.dev) return `${pm} run dev`;
  if (scan.scripts.start) return `${pm} run start`;
  if (scan.scripts.serve) return `${pm} run serve`;
  if (scan.scripts.develop) return `${pm} run develop`;
  if (scan.scripts.watch) return `${pm} run watch`;
  return null;
}

function cwdForLogPlaceholder(): string {
  return process.cwd().replace(process.env.HOME || "", "~");
}

function buildStack(scan: ScanResult): string {
  return [scan.framework, scan.language, scan.packageManager].filter(Boolean).join(" + ") || "unknown";
}

function logLineColor(line: string): string {
  if (/\b(error|failed|exception|crash)\b/i.test(line)) return colors.error;
  if (/\b(warn|deprecated|retry)\b/i.test(line)) return colors.warning;
  if (/\b(ready|started|compiled|success|listening)\b/i.test(line)) return colors.success;
  return colors.text;
}

function elapsedText(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
