import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { collectDashboardStatus, createDashboardFallbackStatus, type DashboardStatus } from "../../status/collector.js";
import { Panel } from "../components/Panel.js";
import { Spinner } from "../components/Spinner.js";
import { KVRow, TooSmallTerminal, TuiFooter, TuiHeader, formatAge, isTerminalTooSmall, shortPath, statusColor } from "../components/TuiFrame.js";
import { useFocusNavigation, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";

interface DashboardLayoutProps {
  cwd: string;
  initialStatus?: DashboardStatus;
  variant?: "dashboard" | "status";
}

interface DashboardLayoutGeometry {
  width: number;
  height: number;
  variant: "dashboard" | "status";
  stacked: boolean;
  compactStacked: boolean;
  bodyHeight: number;
  topHeight: number;
  middleHeight: number;
  bottomHeight: number;
  topWidths: number[];
  leftWidth: number;
  rightWidth: number;
}

export function DashboardLayout({ cwd, initialStatus, variant = "dashboard" }: DashboardLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildDashboardLayout(terminal.width, terminal.height, variant), [terminal.width, terminal.height, variant]);
  const [status, setStatus] = useState<DashboardStatus | null>(initialStatus || null);
  const [error, setError] = useState<string | null>(null);
  const focus = useFocusNavigation({
    items: useMemo(() => buildDashboardFocusItems(layout), [layout]),
    onQuit: () => exit(),
  });

  useEffect(() => {
    let alive = true;
    if (initialStatus) return () => {
      alive = false;
    };
    const timer = setTimeout(() => {
      if (alive) setStatus(createDashboardFallbackStatus(cwd, "Status probes timed out in the interactive dashboard."));
    }, 2500);
    collectDashboardStatus(cwd)
      .then((next) => {
        clearTimeout(timer);
        if (alive) setStatus(next);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (alive) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cwd, initialStatus]);

  const command = variant === "status" ? "setupr status --tui" : "setupr";
  const stack = status?.scan ? buildStack(status.scan) : "collecting";
  const health = status ? status.health.score === null ? "N/A" : `${status.health.score}/100 ${status.health.label}` : "loading";

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command={command} width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader
        command={command}
        title={variant === "status" ? "project status" : "dashboard"}
        cwd={cwd}
        stack={stack}
        status={health}
        statusColor={status ? healthColor(status.health.label) : colors.textDim}
        right={status ? `Checkpoint ${status.history.length ? "saved" : "idle"}` : undefined}
        width={terminal.width}
      />

      {!status && !error && (
        <Box flexGrow={1}>
          <Spinner label="Collecting project status..." />
        </Box>
      )}

      {error && (
        <Box flexGrow={1}>
          <Panel title="Dashboard Error" focusState="focused" width="100%" height="100%">
            <Text color={colors.error}>{error}</Text>
          </Panel>
        </Box>
      )}

      {status && (
        variant === "status"
          ? <StatusScreen layout={layout} status={status} focus={focus.focusState} />
          : <DashboardScreen layout={layout} status={status} focus={focus.focusState} />
      )}

      <TuiFooter
        width={terminal.width}
        left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ scroll/navigate · q quit"
        right={status ? `v${process.env.npm_package_version || "0.0.0"} · ${status.projectName}` : undefined}
      />
    </Box>
  );
}

function DashboardScreen({ layout, status, focus }: ScreenProps) {
  if (layout.stacked) {
    if (layout.compactStacked) {
      const topHeight = clamp(Math.floor(layout.bodyHeight * 0.4), 8, Math.max(8, layout.bodyHeight - 8));
      const bottomHeight = Math.max(6, layout.bodyHeight - topHeight - tuiLayout.panelGap);
      return (
        <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} overflow="hidden" gap={tuiLayout.panelGap}>
          <Box flexDirection="row" width="100%" height={topHeight} gap={tuiLayout.panelGap}>
            <Panel title="Project" focusState={focus("project")} width={layout.leftWidth} height="100%">
              <ProjectPanel status={status} compact />
            </Panel>
            <Panel title="Overview" focusState={focus("overview")} width={layout.rightWidth} height="100%">
              <CompactDashboardOverview status={status} />
            </Panel>
          </Box>
          <Box flexDirection="row" width="100%" height={bottomHeight} gap={tuiLayout.panelGap}>
            <Panel title="Actions + History" focusState={focus("actions")} width={layout.leftWidth} height="100%">
              <ActionsHistoryPanel status={status} limit={bottomHeight - 3} />
            </Panel>
            <Panel title="Notices" focusState={focus("notices")} width={layout.rightWidth} height="100%">
              <NoticePanel status={status} limit={bottomHeight - 3} />
            </Panel>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} overflow="hidden">
        <Panel title="Project" focusState={focus("project")} width="100%" height={5}>
          <ProjectPanel status={status} compact />
        </Panel>
        <Panel title="Git" focusState={focus("git")} width="100%" height={5}>
          <GitPanel status={status} compact />
        </Panel>
        <Panel title="Env" focusState={focus("env")} width="100%" height={5}>
          <EnvPanel status={status} compact />
        </Panel>
        <Panel title="Deps" focusState={focus("deps")} width="100%" height={5}>
          <DepsPanel status={status} compact />
        </Panel>
        <Panel title="Processes" focusState={focus("processes")} width="100%" height={5}>
          <ProcessPanel status={status} compact />
        </Panel>
        <Panel title="Actions + History" focusState={focus("actions")} width="100%" flexGrow={1} minHeight={6}>
          <ActionsHistoryPanel status={status} limit={Math.max(2, layout.bodyHeight - 30)} />
        </Panel>
        <Panel title="Notices" focusState={focus("notices")} width="100%" height={5}>
          <NoticePanel status={status} limit={3} />
        </Panel>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width="100%" height={layout.topHeight} gap={tuiLayout.panelGap}>
        <Panel title="Project" focusState={focus("project")} width={layout.topWidths[0]} height="100%">
          <ProjectPanel status={status} />
        </Panel>
        <Panel title="Git" focusState={focus("git")} width={layout.topWidths[1]} height="100%">
          <GitPanel status={status} />
        </Panel>
        <Panel title="Env" focusState={focus("env")} width={layout.topWidths[2]} height="100%">
          <EnvPanel status={status} />
        </Panel>
        <Panel title="Deps" focusState={focus("deps")} width={layout.topWidths[3]} height="100%">
          <DepsPanel status={status} />
        </Panel>
        <Panel title="Processes" focusState={focus("processes")} width={layout.topWidths[4]} height="100%">
          <ProcessPanel status={status} />
        </Panel>
      </Box>
      <Box flexDirection="row" width="100%" flexGrow={1} minHeight={8} gap={tuiLayout.panelGap}>
        <Panel title="Actions + History" focusState={focus("actions")} width={layout.leftWidth} height="100%">
          <ActionsHistoryPanel status={status} limit={layout.bottomHeight - 3} />
        </Panel>
        <Panel title="Notices" focusState={focus("notices")} width={layout.rightWidth} height="100%">
          <NoticePanel status={status} limit={layout.bottomHeight - 3} />
        </Panel>
      </Box>
    </Box>
  );
}

function StatusScreen({ layout, status, focus }: ScreenProps) {
  if (layout.stacked) {
    if (layout.compactStacked) {
      const topHeight = clamp(Math.floor(layout.bodyHeight * 0.4), 8, Math.max(8, layout.bodyHeight - 8));
      const bottomHeight = Math.max(6, layout.bodyHeight - topHeight - tuiLayout.panelGap);
      return (
        <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} overflow="hidden" gap={tuiLayout.panelGap}>
          <Box flexDirection="row" width="100%" height={topHeight} gap={tuiLayout.panelGap}>
            <Panel title="Health" focusState={focus("health")} width={layout.leftWidth} height="100%">
              <HealthPanel status={status} compact />
            </Panel>
            <Panel title="Overview" focusState={focus("overview")} width={layout.rightWidth} height="100%">
              <CompactStatusOverview status={status} />
            </Panel>
          </Box>
          <Box flexDirection="row" width="100%" height={bottomHeight} gap={tuiLayout.panelGap}>
            <Panel title="Project State" focusState={focus("state")} width={layout.leftWidth} height="100%">
              <ProjectStatePanel status={status} limit={bottomHeight - 3} />
            </Panel>
            <Panel title="Next Actions" focusState={focus("actions")} width={layout.rightWidth} height="100%">
              <NextActionsPanel status={status} limit={bottomHeight - 3} />
            </Panel>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} overflow="hidden">
        <Panel title="Health" focusState={focus("health")} width="100%" height={6}>
          <HealthPanel status={status} compact />
        </Panel>
        <Panel title="Git" focusState={focus("git")} width="100%" height={5}>
          <GitPanel status={status} compact />
        </Panel>
        <Panel title="Env" focusState={focus("env")} width="100%" height={5}>
          <EnvPanel status={status} compact />
        </Panel>
        <Panel title="Tests" focusState={focus("tests")} width="100%" height={5}>
          <TestsPanel status={status} />
        </Panel>
        <Panel title="Security" focusState={focus("security")} width="100%" height={5}>
          <SecurityPanel status={status} />
        </Panel>
        <Panel title="Project State" focusState={focus("state")} width="100%" flexGrow={1} minHeight={6}>
          <ProjectStatePanel status={status} limit={Math.max(2, layout.bodyHeight - 32)} />
        </Panel>
        <Panel title="Next Actions" focusState={focus("actions")} width="100%" height={6}>
          <NextActionsPanel status={status} limit={3} />
        </Panel>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={layout.width} height={layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width="100%" height={layout.topHeight} gap={tuiLayout.panelGap}>
        <Panel title="Health" focusState={focus("health")} width={layout.topWidths[0]} height="100%">
          <HealthPanel status={status} />
        </Panel>
        <Panel title="Git" focusState={focus("git")} width={layout.topWidths[1]} height="100%">
          <GitPanel status={status} />
        </Panel>
        <Panel title="Env" focusState={focus("env")} width={layout.topWidths[2]} height="100%">
          <EnvPanel status={status} />
        </Panel>
        <Panel title="Tests" focusState={focus("tests")} width={layout.topWidths[3]} height="100%">
          <TestsPanel status={status} />
        </Panel>
        <Panel title="Security" focusState={focus("security")} width={layout.topWidths[4]} height="100%">
          <SecurityPanel status={status} />
        </Panel>
      </Box>
      <Box flexDirection="row" width="100%" height={layout.middleHeight} gap={tuiLayout.panelGap}>
        <Panel title="Project State" focusState={focus("state")} width={layout.leftWidth} height="100%">
          <ProjectStatePanel status={status} limit={layout.middleHeight - 3} />
        </Panel>
        <Panel title="Recent Processes" focusState={focus("processes")} width={layout.rightWidth} height="100%">
          <ProcessPanel status={status} limit={layout.middleHeight - 3} />
        </Panel>
      </Box>
      <Box flexDirection="row" width="100%" flexGrow={1} minHeight={6} gap={tuiLayout.panelGap}>
        <Panel title={`Env Vars (${status.env.defined} loaded)`} focusState={focus("envvars")} width={layout.leftWidth} height="100%">
          <EnvVarsPanel status={status} limit={layout.bottomHeight - 3} />
        </Panel>
        <Panel title="Next Actions" focusState={focus("actions")} width={layout.rightWidth} height="100%">
          <NextActionsPanel status={status} limit={layout.bottomHeight - 3} />
        </Panel>
      </Box>
    </Box>
  );
}

interface ScreenProps {
  layout: DashboardLayoutGeometry;
  status: DashboardStatus;
  focus: (id: string) => "focused" | "ancestor" | undefined;
}

function ProjectPanel({ status, compact = false }: { status: DashboardStatus; compact?: boolean }) {
  const scan = status.scan;
  return (
    <Box flexDirection="column">
      <KVRow label="Name" value={status.projectName} />
      <KVRow label="Root" value={shortPath(status.cwd, compact ? 36 : 54)} />
      {!compact && <KVRow label="Stage" value={status.hasProject ? "project" : "no project"} color={status.hasProject ? colors.success : colors.warning} />}
      <KVRow label="Stack" value={scan ? buildStack(scan) : "scan unavailable"} />
      {!compact && <KVRow label="Owner" value={process.env.USER || "local"} dim />}
      {status.scanError && <Text color={colors.warning} wrap="truncate">△ {status.scanError}</Text>}
    </Box>
  );
}

function HealthPanel({ status, compact = false }: { status: DashboardStatus; compact?: boolean }) {
  return (
    <Box flexDirection="column">
      <Text color={healthColor(status.health.label)} bold>{status.health.score === null ? "N/A" : <>{status.health.score} <Text color={colors.textDim}>/100</Text></>}</Text>
      <Text color={healthColor(status.health.label)}>{status.health.label}</Text>
      {!compact && <Text color={colors.textDim}>last check {formatAge(status.collectedAt)} ago</Text>}
      {status.health.score !== null && <Text color={healthColor(status.health.label)}>{healthBar(status.health.score)}</Text>}
    </Box>
  );
}

function GitPanel({ status, compact = false }: { status: DashboardStatus; compact?: boolean }) {
  const git = status.git;
  if (!git.isRepo) return <Text color={colors.warning}>△ Not a git repository</Text>;
  return (
    <Box flexDirection="column">
      <KVRow label="Branch" value={git.branch || "unknown"} />
      <KVRow label="Ahead" value={git.ahead ?? 0} color={(git.ahead ?? 0) > 0 ? colors.warning : undefined} />
      <KVRow label="Behind" value={git.behind ?? 0} color={(git.behind ?? 0) > 0 ? colors.warning : undefined} />
      <KVRow label="Changed" value={git.dirtyFiles} color={git.dirtyFiles > 0 ? colors.warning : colors.success} />
      {!compact && <KVRow label="Status" value={git.dirtyFiles > 0 ? "Dirty" : "Clean"} color={git.dirtyFiles > 0 ? colors.warning : colors.success} />}
    </Box>
  );
}

function EnvPanel({ status, compact = false }: { status: DashboardStatus; compact?: boolean }) {
  const env = status.env;
  return (
    <Box flexDirection="column">
      <KVRow label="File" value={env.hasEnv ? ".env" : "missing"} color={env.hasEnv ? colors.success : colors.warning} />
      <KVRow label="Loaded" value={env.defined} color={env.defined > 0 ? colors.success : undefined} />
      <KVRow label="Missing" value={env.missing.length} color={env.missing.length > 0 ? colors.warning : colors.success} />
      {!compact && <KVRow label="Sensitive" value={estimateSensitive(env.missing, env.extra)} color={estimateSensitive(env.missing, env.extra) > 0 ? colors.error : undefined} />}
      <KVRow label="Status" value={env.missing.length ? "Warn" : env.hasExample || env.hasEnv ? "OK" : "No template"} color={env.missing.length ? colors.warning : colors.success} />
    </Box>
  );
}

function DepsPanel({ status, compact = false }: { status: DashboardStatus; compact?: boolean }) {
  const deps = status.dependencies;
  return (
    <Box flexDirection="column">
      <KVRow label="PM" value={deps.packageManager || "none"} />
      <KVRow label="Total" value={deps.prod + deps.dev} />
      <KVRow label="Prod" value={deps.prod} />
      {!compact && <KVRow label="Dev" value={deps.dev} />}
      <KVRow label="Lock" value={deps.lockfilePresent ? deps.lockfile || "present" : "missing"} color={deps.lockfilePresent ? colors.success : colors.warning} />
    </Box>
  );
}

function TestsPanel({ status }: { status: DashboardStatus }) {
  const hasLastTest = Boolean(status.verification.lastCommand);
  return (
    <Box flexDirection="column">
      <KVRow label="Status" value={status.verification.status} color={statusColor(status.verification.status)} />
      <KVRow label="Last" value={status.verification.lastCommand || "none"} dim={!status.verification.lastCommand} />
      <KVRow label="Coverage" value={hasLastTest ? "report only" : "unknown"} dim />
    </Box>
  );
}

function SecurityPanel({ status }: { status: DashboardStatus }) {
  const risk = securityRisk(status.security.score);
  const scoreColor = status.security.score === null ? colors.textDim : status.security.score >= 90 ? colors.success : status.security.score >= 70 ? colors.warning : colors.error;
  return (
    <Box flexDirection="column">
      <KVRow label="Score" value={status.security.score ?? "N/A"} color={scoreColor} />
      <KVRow label="Findings" value={status.security.findings ?? "N/A"} color={status.security.findings === null ? colors.textDim : status.security.findings > 0 ? colors.warning : colors.success} />
      <KVRow label="Risk" value={risk} color={statusColor(risk)} />
      {status.security.topFindings.slice(0, 2).map((finding, index) => (
        <Text key={`${finding.title}-${index}`} color={colors.textDim} wrap="truncate">· {finding.title}</Text>
      ))}
    </Box>
  );
}

function ProcessPanel({ status, compact = false, limit = compact ? 3 : 5 }: { status: DashboardStatus; compact?: boolean; limit?: number }) {
  if (status.processes.entries.length === 0) {
    return <Text color={colors.textDim}>No Setupr-managed processes.</Text>;
  }
  return (
    <Box flexDirection="column">
      <KVRow label="Running" value={status.processes.running} color={status.processes.running > 0 ? colors.success : undefined} />
      {!compact && <KVRow label="Crashed" value={status.processes.crashed} color={status.processes.crashed > 0 ? colors.error : undefined} />}
      {status.processes.entries.slice(0, Math.max(1, limit - 2)).map((entry) => (
        <Text key={`${entry.name}-${entry.pid || "no-pid"}`} wrap="truncate">
          <Text color={statusColor(entry.status)}>{icons.dot}</Text>
          <Text color={colors.text}> {entry.name}</Text>
          <Text color={colors.textDim}> {entry.pid ? `pid ${entry.pid}` : entry.status}</Text>
        </Text>
      ))}
    </Box>
  );
}

function CompactDashboardOverview({ status }: { status: DashboardStatus }) {
  return (
    <Box flexDirection="column">
      <KVRow label="Git" value={status.git.isRepo ? `${status.git.branch || "repo"} · ${status.git.dirtyFiles ? "dirty" : "clean"}` : "no repo"} color={status.git.dirtyFiles ? colors.warning : status.git.isRepo ? colors.success : colors.textDim} />
      <KVRow label="Env" value={status.env.hasEnv ? `${status.env.defined}/${status.env.required || status.env.defined} loaded` : "missing"} color={status.env.missing.length ? colors.warning : status.env.hasEnv ? colors.success : colors.textDim} />
      <KVRow label="Deps" value={`${status.dependencies.prod + status.dependencies.dev} packages`} />
      <KVRow label="Proc" value={`${status.processes.running}/${status.processes.managed} running`} color={status.processes.crashed ? colors.error : status.processes.running ? colors.success : colors.textDim} />
    </Box>
  );
}

function CompactStatusOverview({ status }: { status: DashboardStatus }) {
  const risk = securityRisk(status.security.score);
  return (
    <Box flexDirection="column">
      <KVRow label="Git" value={status.git.isRepo ? `${status.git.branch || "repo"} · ${status.git.dirtyFiles ? "dirty" : "clean"}` : "no repo"} color={status.git.dirtyFiles ? colors.warning : status.git.isRepo ? colors.success : colors.textDim} />
      <KVRow label="Env" value={status.env.missing.length ? `${status.env.missing.length} missing` : "ok"} color={status.env.missing.length ? colors.warning : colors.success} />
      <KVRow label="Tests" value={status.verification.status} color={statusColor(status.verification.status)} />
      <KVRow label="Risk" value={risk} color={statusColor(risk)} />
    </Box>
  );
}

function ActionsHistoryPanel({ status, limit }: { status: DashboardStatus; limit: number }) {
  const rows = [
    ...status.history.slice(-Math.max(0, Math.floor(limit / 2))).map((event) => ({
      left: formatTime(event.timestamp),
      middle: event.type,
      status: event.type.includes("error") ? "error" : event.type.includes("warning") ? "warn" : "complete",
      detail: event.message || "finished",
      color: event.type.includes("error") ? colors.error : event.type.includes("warning") ? colors.warning : colors.success,
    })),
    ...preferredCommands(status).slice(0, Math.max(2, limit - Math.floor(limit / 2))).map((command) => ({
      left: "shortcut",
      middle: command.name,
      status: "ready",
      detail: command.summary,
      color: colors.primary,
    })),
  ].slice(0, Math.max(1, limit));

  return (
    <Box flexDirection="column">
      <Text color={colors.heading}>TIME     ACTION                 STATUS    DETAIL</Text>
      {rows.length === 0 ? <Text color={colors.textDim}>No local history yet.</Text> : rows.map((row, index) => (
        <Text key={`${row.left}-${row.middle}-${index}`} wrap="truncate">
          <Text color={colors.textDim}>{fitCell(row.left, 8)} </Text>
          <Text color={row.color}>{fitCell(row.middle, 20)} </Text>
          <Text color={row.color}>{fitCell(row.status, 9)} </Text>
          <Text color={colors.textDim}>{row.detail}</Text>
        </Text>
      ))}
    </Box>
  );
}

function NoticePanel({ status, limit }: { status: DashboardStatus; limit: number }) {
  const notices = buildNotices(status);
  return (
    <Box flexDirection="column">
      {notices.length === 0 ? <Text color={colors.success}>✓ No major notices</Text> : notices.slice(0, Math.max(1, limit)).map((notice, index) => (
        <Text key={`${notice.text}-${index}`} color={notice.color} wrap="truncate">
          {notice.icon} {notice.text}
        </Text>
      ))}
    </Box>
  );
}

function ProjectStatePanel({ status, limit }: { status: DashboardStatus; limit: number }) {
  const rows = status.history.length ? status.history : status.logs;
  if (rows.length === 0) return <Text color={colors.textDim}>No Setupr timeline yet.</Text>;
  return (
    <Box flexDirection="column">
      {rows.slice(-Math.max(1, limit)).map((event, index) => (
        <Text key={`${event.timestamp}-${event.type}-${index}`} wrap="truncate">
          <Text color={colors.textDim}>{fitCell(formatTime(event.timestamp), 8)} </Text>
          <Text color={colors.text}>{fitCell(event.message || event.type, 42)} </Text>
          <Text color={event.type.includes("error") ? colors.error : event.type.includes("warning") ? colors.warning : colors.success}>{event.type.includes("error") ? "error" : event.type.includes("warning") ? "warn" : "complete"}</Text>
        </Text>
      ))}
    </Box>
  );
}

function EnvVarsPanel({ status, limit }: { status: DashboardStatus; limit: number }) {
  const rows = [
    ...status.env.missing.map((key) => ({ key, value: "missing", color: colors.warning })),
    ...status.env.extra.map((key) => ({ key, value: "extra", color: colors.info })),
  ];
  if (rows.length === 0) return <Text color={colors.success}>✓ Env state is clean.</Text>;
  return (
    <Box flexDirection="column">
      {rows.slice(0, Math.max(1, limit)).map((row) => (
        <KVRow key={`${row.key}-${row.value}`} label={row.key} value={row.value} color={row.color} />
      ))}
      {rows.length > limit && <Text color={colors.textDim}>… and {rows.length - limit} more</Text>}
    </Box>
  );
}

function NextActionsPanel({ status, limit }: { status: DashboardStatus; limit: number }) {
  const actions = nextActions(status);
  return (
    <Box flexDirection="column">
      {actions.slice(0, Math.max(1, limit)).map((action) => (
        <Text key={action} color={colors.warning} wrap="truncate">· {action}</Text>
      ))}
    </Box>
  );
}

export function buildDashboardLayout(width: number, height: number, variant: "dashboard" | "status" = "dashboard"): DashboardLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 104 || bodyHeight < 22;
  const compactStacked = stacked && bodyHeight < 40;
  const gap = tuiLayout.panelGap;
  const rowGaps = stacked ? (compactStacked ? gap : 0) : (variant === "status" ? gap * 2 : gap);
  const topHeight = stacked ? 5 : clamp(Math.floor(bodyHeight * 0.28), 7, 10);
  const middleHeight = stacked ? 0 : variant === "status" ? clamp(Math.floor(bodyHeight * 0.36), 8, Math.max(8, bodyHeight - topHeight - 6)) : 0;
  const bottomHeight = Math.max(6, bodyHeight - topHeight - middleHeight - rowGaps);
  const topTotal = stacked ? width : Math.max(1, width - gap * 4);
  const topWidths = distributeWidths(topTotal, variant === "status" ? [0.9, 1, 1, 1, 1] : [1.25, 1, 1, 1, 1], [18, 16, 16, 16, 18]);
  let leftWidth = width;
  let rightWidth = width;
  if (compactStacked) {
    [leftWidth, rightWidth] = distributeWidths(Math.max(1, width - gap), [1, 1], [24, 24]);
  } else if (!stacked) {
    const pairTotal = Math.max(1, width - gap);
    leftWidth = variant === "status" ? Math.floor(pairTotal * 0.62) : Math.floor(pairTotal * 0.63);
    rightWidth = pairTotal - leftWidth;
  }
  return { width, height, variant, stacked, compactStacked, bodyHeight, topHeight, middleHeight, bottomHeight, topWidths, leftWidth, rightWidth };
}

export function buildDashboardFocusItems(layout: DashboardLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    if (layout.compactStacked) {
      const ids = layout.variant === "status" ? ["health", "overview", "state", "actions"] : ["project", "overview", "actions", "notices"];
      const topHeight = clamp(Math.floor(layout.bodyHeight * 0.4), 8, Math.max(8, layout.bodyHeight - 8));
      const bottomHeight = Math.max(6, layout.bodyHeight - topHeight - tuiLayout.panelGap);
      return [
        { id: ids[0], row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.leftWidth, height: topHeight } },
        { id: ids[1], row: 0, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: 2, width: layout.rightWidth, height: topHeight } },
        { id: ids[2], row: 1, column: 0, bounds: { x: 1, y: 2 + topHeight + tuiLayout.panelGap, width: layout.leftWidth, height: bottomHeight } },
        { id: ids[3], row: 1, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: 2 + topHeight + tuiLayout.panelGap, width: layout.rightWidth, height: bottomHeight } },
      ];
    }
    const common = layout.variant === "status"
      ? ["health", "git", "env", "tests", "security", "state", "actions"]
      : ["project", "git", "env", "deps", "processes", "actions", "notices"];
    let y = 2;
    return common.map((id, index) => {
      const height = index < 5 ? 5 : index === 5 ? Math.max(6, layout.bodyHeight - 31) : 6;
      const item = { id, row: index, column: 0, bounds: { x: 1, y, width: layout.width, height } };
      y += height;
      return item;
    });
  }

  const items: FocusItem[] = [];
  let x = 1;
  const topIds = layout.variant === "status" ? ["health", "git", "env", "tests", "security"] : ["project", "git", "env", "deps", "processes"];
  topIds.forEach((id, index) => {
    items.push({ id, row: 0, column: index, bounds: { x, y: 2, width: layout.topWidths[index], height: layout.topHeight } });
    x += layout.topWidths[index] + tuiLayout.panelGap;
  });
  const mainY = 2 + layout.topHeight + tuiLayout.panelGap;
  if (layout.variant === "status") {
    items.push({ id: "state", row: 1, column: 0, bounds: { x: 1, y: mainY, width: layout.leftWidth, height: layout.middleHeight } });
    items.push({ id: "processes", row: 1, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: mainY, width: layout.rightWidth, height: layout.middleHeight } });
    items.push({ id: "envvars", row: 2, column: 0, bounds: { x: 1, y: mainY + layout.middleHeight + tuiLayout.panelGap, width: layout.leftWidth, height: layout.bottomHeight } });
    items.push({ id: "actions", row: 2, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: mainY + layout.middleHeight + tuiLayout.panelGap, width: layout.rightWidth, height: layout.bottomHeight } });
  } else {
    items.push({ id: "actions", row: 1, column: 0, bounds: { x: 1, y: mainY, width: layout.leftWidth, height: layout.bottomHeight } });
    items.push({ id: "notices", row: 1, column: 1, bounds: { x: layout.leftWidth + tuiLayout.panelGap + 1, y: mainY, width: layout.rightWidth, height: layout.bottomHeight } });
  }
  return items;
}

function preferredCommands(status: DashboardStatus) {
  const preferred = ["setup", "env", "doctor", "start", "status", "test", "security", "git", "build"];
  return preferred
    .map((name) => status.commands.find((command) => command.name === name))
    .filter((command): command is { name: string; summary: string } => Boolean(command));
}

function buildNotices(status: DashboardStatus) {
  const notices: Array<{ icon: string; text: string; color: string }> = [];
  for (const check of status.health.checks.filter((item) => item.status !== "ok")) {
    notices.push({
      icon: check.status === "error" ? "●" : "△",
      text: `${check.label}: ${check.detail}`,
      color: check.status === "error" ? colors.error : colors.warning,
    });
  }
  for (const key of status.env.missing.slice(0, 4)) {
    notices.push({ icon: "·", text: `.env missing ${key}`, color: colors.warning });
  }
  for (const finding of status.security.topFindings.slice(0, 3)) {
    notices.push({ icon: "●", text: finding.title, color: colors.error });
  }
  return notices;
}

function nextActions(status: DashboardStatus): string[] {
  const actions: string[] = [];
  if (!status.hasProject) actions.push("Open a project directory");
  if (status.env.missing.length > 0) actions.push(`Fill ${status.env.missing[0]} in .env`);
  if (!status.dependencies.lockfilePresent && status.dependencies.packageManager) actions.push("Create or sync lockfile");
  if (status.git.isRepo && status.git.dirtyFiles > 0) actions.push("Review uncommitted changes");
  if (status.processes.crashed > 0) actions.push("Inspect crashed process logs");
  if (status.security.score === null || (status.security.findings ?? 0) > 0) actions.push("Run setupr security scan");
  if (actions.length === 0) actions.push("Project state looks good");
  return actions;
}

function estimateSensitive(missing: string[], extra: string[]): number {
  return [...missing, ...extra].filter((key) => /(key|token|secret|password|auth)/i.test(key)).length;
}

function buildStack(scan: NonNullable<DashboardStatus["scan"]>): string {
  return [scan.framework, scan.language, scan.packageManager, ...scan.services.slice(0, 1)].filter(Boolean).join(" + ") || "unknown";
}

function healthColor(label: DashboardStatus["health"]["label"]) {
  if (label === "good") return colors.success;
  if (label === "warning") return colors.warning;
  return colors.error;
}

function securityRisk(score: number | null): string {
  return score === null ? "N/A" : score >= 90 ? "Low" : score >= 70 ? "Moderate" : "High";
}

function healthBar(score: number): string {
  const filled = Math.max(0, Math.min(12, Math.round(score / 8.34)));
  return `${"█".repeat(filled)}${"░".repeat(12 - filled)}`;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fitCell(value: string, width: number): string {
  if (value.length === width) return value;
  if (value.length > width) return `${value.slice(0, Math.max(0, width - 1))}…`;
  return value.padEnd(width, " ");
}

function distributeWidths(total: number, weights: number[], mins: number[]): number[] {
  const minTotal = mins.reduce((sum, item) => sum + item, 0);
  if (total <= minTotal) return fitWidths(total, mins.length);
  const extra = total - minTotal;
  const weightTotal = weights.reduce((sum, item) => sum + item, 0);
  const widths = mins.map((min, index) => min + Math.floor(extra * (weights[index] / weightTotal)));
  widths[widths.length - 1] += total - widths.reduce((sum, item) => sum + item, 0);
  return widths;
}

function fitWidths(total: number, count: number): number[] {
  const base = Math.max(1, Math.floor(total / count));
  const widths = Array.from({ length: count }, () => base);
  widths[widths.length - 1] += total - widths.reduce((sum, item) => sum + item, 0);
  return widths;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
