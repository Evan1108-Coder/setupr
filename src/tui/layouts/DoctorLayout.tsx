import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { collectContext } from "../../context/collector.js";
import { doctorInsights, type DoctorInsight } from "../../agent/runtime.js";
import { classifyCommandFailure, createSetuprError, type SetuprError } from "../../errors/index.js";
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

interface Check {
  label: string;
  status: "pass" | "fail" | "warn" | "checking";
  detail?: string;
  error?: SetuprError;
}

interface DoctorLayoutProps {
  scan: ScanResult;
  cwd: string;
}

interface DoctorLayoutGeometry {
  width: number;
  height: number;
  stacked: boolean;
  bodyHeight: number;
  groupWidth: number;
  diagWidth: number;
  sideWidth: number;
  diagHeight: number;
  inputMaxLines: number;
  inputHeight: number;
  inputBounds: FocusBounds;
}

export function DoctorLayout({ scan, cwd }: DoctorLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildDoctorLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildDoctorFocusItems(layout), [layout]), onQuit: () => exit() });
  const noProject = !hasProjectSignals(scan);
  const [checks, setChecks] = useState<Check[]>([]);
  const [insights, setInsights] = useState<DoctorInsight[]>([]);
  const [done, setDone] = useState(false);
  const { chatEvents, handleChat, pending: aiPending, label: aiLabel } = usePanelChat({
    scan,
    command: "doctor",
    context: `Doctor results: ${checks.map((check) => `${check.label}: ${check.status}${check.detail ? ` (${check.detail})` : ""}`).join(", ")}`,
  });

  useEffect(() => {
    runDiagnostics(scan, cwd, noProject).then(async (results) => {
      setChecks(results);
      const context = await collectContext(cwd, scan).catch(() => null);
      setInsights(context ? doctorInsights(context) : []);
      setDone(true);
    });
  }, []);

  const passCount = checks.filter((check) => check.status === "pass").length;
  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const risk = failCount > 0 ? "High" : warnCount > 0 ? "Moderate" : done ? "Low" : "Checking";

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr doctor" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader
        command="setupr doctor"
        cwd={cwd}
        stack={buildStack(scan)}
        status={done ? `${passCount} ok · ${failCount} failed · ${warnCount} warn` : "checking"}
        statusColor={statusColor(risk)}
        right={`Risk ${risk}`}
        width={terminal.width}
      />

      {layout.stacked ? (
        <StackedDoctor
          layout={layout}
          scan={scan}
          checks={checks}
          insights={insights}
          done={done}
          risk={risk}
          noProject={noProject}
          chatEvents={chatEvents}
          aiPending={aiPending}
          aiLabel={aiLabel}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={handleChat}
        />
      ) : (
        <WideDoctor
          layout={layout}
          scan={scan}
          checks={checks}
          insights={insights}
          done={done}
          risk={risk}
          noProject={noProject}
          chatEvents={chatEvents}
          aiPending={aiPending}
          aiLabel={aiLabel}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={handleChat}
        />
      )}

      <TuiFooter
        width={terminal.width}
        left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Enter ask · q quit outside input"
        right={done ? `${checks.length} checks done` : "checking..."}
      />
    </Box>
  );
}

function WideDoctor(props: DoctorViewProps) {
  const sideUsableHeight = Math.max(8, props.layout.bodyHeight - tuiLayout.panelGap);
  const envHeight = Math.max(8, Math.floor(sideUsableHeight * 0.45));
  return (
    <Box flexDirection="row" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Panel title="Check Groups" focusState={props.focus("groups")} width={props.layout.groupWidth} height="100%">
        <CheckGroups checks={props.checks} done={props.done} />
      </Panel>
      <DiagnosticsPanel {...props} width={props.layout.diagWidth} height="100%" />
      <Box flexDirection="column" width={props.layout.sideWidth} height="100%" gap={tuiLayout.panelGap}>
        <Panel title="Environment" focusState={props.focus("environment")} width="100%" height={envHeight}>
          <EnvironmentPanel scan={props.scan} />
        </Panel>
        <Panel title="AI Diagnosis" focusState={props.focus("ai")} width="100%" flexGrow={1} minHeight={7}>
          <AIDiagnosis insights={props.insights} risk={props.risk} />
        </Panel>
      </Box>
    </Box>
  );
}

function StackedDoctor(props: DoctorViewProps) {
  const { groupHeight, diagHeight, envHeight, aiHeight } = stackedDoctorHeights(props.layout.bodyHeight);
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Panel title="Check Groups" focusState={props.focus("groups")} width="100%" height={groupHeight}>
        <CheckGroups checks={props.checks} done={props.done} compact />
      </Panel>
      <DiagnosticsPanel {...props} width={props.layout.width} height={diagHeight} />
      <Panel title="Environment" focusState={props.focus("environment")} width="100%" height={envHeight}>
        <EnvironmentPanel scan={props.scan} compact />
      </Panel>
      <Panel title="AI Diagnosis" focusState={props.focus("ai")} width="100%" height={aiHeight}>
        <AIDiagnosis insights={props.insights} risk={props.risk} compact />
      </Panel>
    </Box>
  );
}

function DiagnosticsPanel({
  layout,
  checks,
  done,
  noProject,
  chatEvents,
  aiPending,
  aiLabel,
  focus,
  inputActive,
  inputBounds,
  onChat,
  width,
  height,
}: DoctorViewProps & { width: number; height: number | string }) {
  const chatRows = chatEvents.length ? Math.max(1, Math.min(8, Math.floor((layout.diagHeight - layout.inputHeight - 3) / 2))) : 0;
  const checkLimit = Math.max(1, layout.diagHeight - layout.inputMaxLines - 6 - chatRows);
  return (
    <Panel title="Diagnostics" focusState={focus("diagnostics")} width={width} height={height}>
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <Box flexDirection="column" flexShrink={0}>
          {checks.slice(0, checkLimit).map((check, index) => (
            <Text key={`${check.label}-${index}`} color={getCheckColor(check.status)} wrap="truncate">
              {getCheckIcon(check.status)} {check.label}{check.detail ? ` - ${check.detail}` : ""}{check.error ? ` (${check.error.code})` : ""}
            </Text>
          ))}
          {!done && checks.length === 0 && pendingDiagnosticRows().slice(0, checkLimit).map((check) => (
            <Text key={check.label} color={colors.textDim} wrap="truncate">
              {icons.spinner[0]} {check.label} - {check.detail}
            </Text>
          ))}
          {checks.length > checkLimit && <Text color={colors.textDim}>… {checks.length - checkLimit} more checks</Text>}
          {!done && <Spinner label="Running diagnostics..." />}
          </Box>
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
          placeholder={noProject ? "Open a project folder, then run doctor again..." : "Ask the doctor a question..."}
          width={Math.max(12, width - 4)}
          maxLines={layout.inputMaxLines}
          scrollBounds={inputBounds}
        />
      </Box>
    </Panel>
  );
}

function CheckGroups({ checks, done, compact = false }: { checks: Check[]; done: boolean; compact?: boolean }) {
  if (compact) return <Text wrap="truncate" color={colors.textDim}>{done ? `${checks.length} checks: ${checks.filter(c => c.status === "fail").length} failed, ${checks.filter(c => c.status === "warn").length} warnings` : "Checking runtime, dependencies, environment and Git..."}</Text>;
  const groups = [
    { label: "Runtime", match: /runtime|node|python|go|rust|cargo|npm|pnpm|yarn|bun/i },
    { label: "Dependencies", match: /dependencies|package|install|lock/i },
    { label: "Environment", match: /\.env|env|config/i },
    { label: "Git", match: /git|remote/i },
    { label: "Terminal", match: /terminal|port|shell/i },
    { label: "AI Provider", match: /ai|provider|auth/i },
    { label: "Network", match: /network|remote/i },
  ];
  return (
    <Box flexDirection="column">
      {groups.slice(0, compact ? 3 : groups.length).map((group) => {
        const matching = checks.filter((check) => group.match.test(check.label));
        const failed = matching.some((check) => check.status === "fail");
        const warned = matching.some((check) => check.status === "warn");
        const color = !done ? colors.textDim : failed ? colors.error : warned ? colors.warning : matching.length ? colors.success : colors.textDim;
        return <Text key={group.label} color={color} wrap="truncate">{done ? statusIcon(failed, warned, matching.length) : icons.spinner[0]} {group.label}</Text>;
      })}
    </Box>
  );
}

function EnvironmentPanel({ scan, compact = false }: { scan: ScanResult; compact?: boolean }) {
  if (compact) return <Text wrap="truncate" color={colors.text}>{process.platform} · {process.version} · {scan.packageManager || "no package manager"}</Text>;
  return (
    <Box flexDirection="column">
      <KVRow label="OS" value={`${process.platform} ${process.arch}`} />
      <KVRow label="Node" value={process.version} />
      {!compact && <KVRow label="Shell" value={process.env.SHELL || "unknown"} />}
      <KVRow label="Terminal" value={process.env.TERM_PROGRAM || process.env.TERM || "terminal"} />
      <KVRow label="PM" value={scan.packageManager || "none"} />
      {!compact && <KVRow label="Language" value={scan.language || "unknown"} />}
      {!compact && <KVRow label="Framework" value={scan.framework || "none"} />}
      {!compact && scan.services.length > 0 && <KVRow label="Services" value={scan.services.join(", ")} color={colors.warning} />}
    </Box>
  );
}

function AIDiagnosis({ insights, risk, compact = false }: { insights: DoctorInsight[]; risk: string; compact?: boolean }) {
  if (compact) return <Text wrap="truncate" color={statusColor(risk)}>Risk: {risk}{insights[0] ? ` · ${insights[0].issue}` : " · Waiting for diagnostics"}</Text>;
  return (
    <Box flexDirection="column">
      <KVRow label="Risk level" value={risk} color={statusColor(risk)} />
      {insights.length === 0 ? (
        <>
          <Text color={colors.textDim}>Waiting for diagnostic context.</Text>
          <Text color={colors.label} wrap="wrap">The doctor will summarize causes and next actions after checks finish.</Text>
        </>
      ) : insights.slice(0, 5).map((insight) => (
        <Text key={insight.issue} color={insight.severity === "error" ? colors.error : insight.severity === "warning" ? colors.warning : colors.info} wrap="truncate">
          {insight.issue}: {insight.fix?.command || insight.explanation}
        </Text>
      ))}
    </Box>
  );
}

export function buildDoctorLayout(width: number, height: number): DoctorLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 112 || bodyHeight < 22;
  const gap = tuiLayout.panelGap;
  const groupWidth = stacked ? width : clamp(Math.floor(width * 0.18), 20, 30);
  const sideWidth = stacked ? width : clamp(Math.floor(width * 0.25), 30, 42);
  const diagWidth = stacked ? width : Math.max(8, width - groupWidth - sideWidth - gap * 2);
  const stackedHeights = stacked ? stackedDoctorHeights(bodyHeight) : null;
  const diagHeight = stacked ? stackedHeights!.diagHeight : bodyHeight;
  const inputMaxLines = Math.max(1, Math.min(6, Math.floor(diagHeight / 4)));
  const inputHeight = inputMaxLines + 2;
  const stackedGroups = stacked ? stackedHeights!.groupHeight : 0;
  const diagY = stacked ? 2 + stackedGroups + gap : 2;
  const inputBounds = { x: stacked ? 3 : groupWidth + gap + 3, y: Math.max(4, diagY + diagHeight - inputHeight - 1), width: Math.max(8, diagWidth - 6), height: inputHeight };
  return { width, height, stacked, bodyHeight, groupWidth, diagWidth, sideWidth, diagHeight, inputMaxLines, inputHeight, inputBounds };
}

export function buildDoctorFocusItems(layout: DoctorLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    const { groupHeight, diagHeight, envHeight, aiHeight } = stackedDoctorHeights(layout.bodyHeight);
    const diagY = 2 + groupHeight + tuiLayout.panelGap;
    const envY = diagY + diagHeight + tuiLayout.panelGap;
    return [
      { id: "groups", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.width, height: groupHeight } },
      { id: "diagnostics", row: 1, column: 0, redirectTo: "input", bounds: { x: 1, y: diagY, width: layout.width, height: diagHeight } },
      { id: "input", row: 2, column: 0, parentIds: ["diagnostics"], bounds: layout.inputBounds },
      { id: "environment", row: 3, column: 0, bounds: { x: 1, y: envY, width: layout.width, height: envHeight } },
      { id: "ai", row: 4, column: 0, bounds: { x: 1, y: envY + envHeight + tuiLayout.panelGap, width: layout.width, height: aiHeight } },
    ];
  }
  const sideX = layout.groupWidth + layout.diagWidth + tuiLayout.panelGap * 2 + 1;
  const sideUsableHeight = Math.max(8, layout.bodyHeight - tuiLayout.panelGap);
  const envHeight = Math.max(8, Math.floor(sideUsableHeight * 0.45));
  return [
    { id: "groups", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.groupWidth, height: layout.bodyHeight } },
    { id: "diagnostics", row: 0, column: 1, redirectTo: "input", bounds: { x: layout.groupWidth + tuiLayout.panelGap + 1, y: 2, width: layout.diagWidth, height: layout.bodyHeight } },
    { id: "input", row: 1, column: 1, parentIds: ["diagnostics"], bounds: layout.inputBounds },
    { id: "environment", row: 0, column: 2, bounds: { x: sideX, y: 2, width: layout.sideWidth, height: envHeight } },
    { id: "ai", row: 1, column: 2, bounds: { x: sideX, y: 2 + envHeight + tuiLayout.panelGap, width: layout.sideWidth, height: sideUsableHeight - envHeight } },
  ];
}

function stackedDoctorHeights(bodyHeight: number) {
  const gapTotal = tuiLayout.panelGap * 3;
  const available = Math.max(8, bodyHeight - gapTotal);
  if (bodyHeight < 20) {
    const groupHeight = 3;
    const envHeight = 3;
    const aiHeight = 2;
    return {
      groupHeight,
      diagHeight: Math.max(3, available - groupHeight - envHeight - aiHeight),
      envHeight,
      aiHeight,
    };
  }
  const groupHeight = Math.max(4, Math.min(6, Math.floor(bodyHeight * 0.20)));
  const envHeight = Math.max(4, Math.min(5, Math.floor(bodyHeight * 0.18)));
  const aiHeight = Math.max(4, Math.min(7, Math.floor(bodyHeight * 0.18)));
  return {
    groupHeight,
    diagHeight: Math.max(4, available - groupHeight - envHeight - aiHeight),
    envHeight,
    aiHeight,
  };
}

interface DoctorViewProps {
  layout: DoctorLayoutGeometry;
  scan: ScanResult;
  checks: Check[];
  insights: DoctorInsight[];
  done: boolean;
  risk: string;
  noProject: boolean;
  chatEvents: TimelineEvent[];
  aiPending: boolean;
  aiLabel: string;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  inputActive: boolean;
  inputBounds?: FocusBounds;
  onChat: (text: string) => void;
}

async function runDiagnostics(scan: ScanResult, cwd: string, noProject: boolean): Promise<Check[]> {
  const checks: Check[] = [];

  if (noProject) {
    checks.push({
      label: "Project files",
      status: "warn",
      detail: "none detected in current directory",
      error: createSetuprError({ code: "NO_PROJECT_DETECTED", command: "doctor", cwd, canContinue: true }),
    });
  }

  if (scan.runtime) {
    const result = await runCommand(`${scan.runtime.name} --version`, cwd);
    if (result.exitCode === 0) {
      const version = result.stdout.trim().split("\n")[0];
      if (scan.runtime.version && !versionSatisfies(version, scan.runtime.version)) {
        checks.push({ label: `${scan.runtime.name} runtime`, status: "warn", detail: `${version} (expected ${scan.runtime.version})` });
      } else {
        checks.push({ label: `${scan.runtime.name} runtime`, status: "pass", detail: version });
      }
    } else {
      checks.push({
        label: `${scan.runtime.name} runtime`,
        status: "fail",
        detail: "not found",
        error: classifyCommandFailure({
          command: `${scan.runtime.name} --version`,
          cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stepLabel: `${scan.runtime.name} runtime`,
        }),
      });
    }
  }

  if (scan.packageManager) {
    const result = await runCommand(`${scan.packageManager} --version`, cwd);
    if (result.exitCode === 0) {
      checks.push({ label: `${scan.packageManager}`, status: "pass", detail: result.stdout.trim().split("\n")[0] });
    } else {
      checks.push({
        label: `${scan.packageManager}`,
        status: "fail",
        detail: "not installed",
        error: classifyCommandFailure({
          command: `${scan.packageManager} --version`,
          cwd,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          stepLabel: `${scan.packageManager} package manager`,
        }),
      });
    }
  }

  if (scan.packageManager === "npm" || scan.packageManager === "yarn" || scan.packageManager === "pnpm" || scan.packageManager === "bun") {
    try {
      const { access } = await import("fs/promises");
      const { join } = await import("path");
      await access(join(cwd, "node_modules"));
      checks.push({ label: "Dependencies installed", status: "pass" });
    } catch {
      checks.push({
        label: "Dependencies installed",
        status: "fail",
        detail: `run '${scan.packageManager} install'`,
        error: createSetuprError({
          code: "INSTALL_FAILED",
          command: "doctor",
          cwd,
          details: [`Missing dependency folder for ${scan.packageManager}.`],
          canContinue: true,
        }),
      });
    }
  }

  try {
    const result = await runCommand("git status --porcelain", cwd);
    if (result.exitCode === 0) {
      const dirty = result.stdout.trim().length > 0;
      checks.push({ label: "Git repository", status: "pass", detail: dirty ? "dirty" : "clean" });
    } else {
      checks.push({ label: "Git repository", status: "warn", detail: "not a git repo" });
    }
  } catch {
    checks.push({ label: "Git repository", status: "warn", detail: "not a git repo" });
  }

  if (scan.configFiles.includes(".env.example")) {
    try {
      const { access } = await import("fs/promises");
      const { join } = await import("path");
      await access(join(cwd, ".env"));
      checks.push({ label: ".env file", status: "pass" });
    } catch {
      checks.push({
        label: ".env file",
        status: "warn",
        detail: "missing - run 'setupr env init'",
        error: createSetuprError({ code: "ENV_CHECK_FAILED", command: "doctor", cwd, details: [".env.example exists but .env is missing."], canContinue: true }),
      });
    }
  }

  if (scan.scripts.build) checks.push({ label: "Build script", status: "pass", detail: scan.scripts.build });
  if (scan.scripts.test) checks.push({ label: "Test script", status: "pass", detail: scan.scripts.test });
  if (!scan.scripts.test && !scan.scripts.build && !noProject) checks.push({ label: "Build/test scripts", status: "warn", detail: "none defined" });

  const commonPorts = [3000, 5173, 8080, 4200];
  for (const port of commonPorts) {
    try {
      const result = await runCommand(`lsof -i :${port} -t 2>/dev/null`, cwd);
      if (result.stdout.trim()) {
        checks.push({ label: `Port ${port}`, status: "warn", detail: `in use (PID ${result.stdout.trim().split("\n")[0]})` });
      }
    } catch {}
  }

  try {
    const result = await runCommand("git remote get-url origin 2>/dev/null", cwd);
    if (result.exitCode === 0 && result.stdout.trim()) {
      checks.push({ label: "Remote", status: "pass", detail: result.stdout.trim().replace(/.*\//, "").replace(".git", "") });
    }
  } catch {}

  if (checks.length === 0) checks.push({ label: "Project files", status: "warn", detail: "nothing checkable detected" });
  return checks;
}

function pendingDiagnosticRows(): Check[] {
  return [
    { label: "Runtime", status: "checking", detail: "checking language runtime and version" },
    { label: "Dependencies", status: "checking", detail: "checking package manager and lockfile" },
    { label: "Environment", status: "checking", detail: "checking .env and template state" },
    { label: "Git", status: "checking", detail: "checking repository and remote" },
    { label: "Terminal", status: "checking", detail: "checking terminal capabilities" },
    { label: "AI Provider", status: "checking", detail: "checking configured model provider" },
    { label: "Network", status: "checking", detail: "checking remote access where needed" },
  ];
}

function getCheckIcon(status: Check["status"]): string {
  switch (status) {
    case "pass": return icons.check;
    case "fail": return icons.cross;
    case "warn": return icons.warning;
    case "checking": return icons.spinner[0];
  }
}

function getCheckColor(status: Check["status"]): string {
  switch (status) {
    case "pass": return colors.success;
    case "fail": return colors.error;
    case "warn": return colors.warning;
    case "checking": return colors.textDim;
  }
}

function statusIcon(failed: boolean, warned: boolean, present: number): string {
  if (!present) return icons.circle;
  if (failed) return icons.cross;
  if (warned) return icons.warning;
  return icons.check;
}

function buildStack(scan: ScanResult): string {
  return [scan.framework, scan.language, scan.packageManager].filter(Boolean).join(" + ") || "unknown";
}

function versionSatisfies(actualText: string, expected: string): boolean {
  const actual = parseVersion(actualText);
  if (!actual) return actualText.includes(expected);
  const clauses = expected.split(/\s+/).filter(Boolean);
  if (clauses.length === 0) return true;
  return clauses.every((clause) => {
    const match = clause.match(/^(>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})/);
    if (!match) return actualText.includes(clause);
    const [, op = "=", version] = match;
    const target = normalizeVersion(version);
    const cmp = compareVersions(actual, target);
    switch (op) {
      case ">=": return cmp >= 0;
      case "<=": return cmp <= 0;
      case ">": return cmp > 0;
      case "<": return cmp < 0;
      case "^": return actual[0] === target[0] && cmp >= 0;
      case "~": return actual[0] === target[0] && actual[1] === target[1] && cmp >= 0;
      default: return cmp === 0;
    }
  });
}

function parseVersion(text: string): [number, number, number] | null {
  const match = text.match(/v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function normalizeVersion(version: string): [number, number, number] {
  const parsed = parseVersion(version);
  return parsed || [0, 0, 0];
}

function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
