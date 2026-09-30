import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { classifyCommandFailure, createSetuprError, fromUnknownError, type SetuprError } from "../../errors/index.js";
import { runCommand } from "../../executor/index.js";
import type { ScanResult } from "../../scanner/index.js";
import { ChatInput } from "../components/ChatInput.js";
import { Panel } from "../components/Panel.js";
import { Spinner } from "../components/Spinner.js";
import { Timeline, type TimelineEvent } from "../components/Timeline.js";
import { KVRow, MetricText, TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall, statusColor } from "../components/TuiFrame.js";
import { useFocusNavigation, type FocusBounds, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { usePanelChat } from "../hooks/usePanelChat.js";
import { hasProjectSignals } from "../projectSignals.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";

interface OutdatedPkg {
  name: string;
  current: string;
  latest: string;
  type: "major" | "minor" | "patch";
}

interface UpdateResult {
  packages: OutdatedPkg[];
  notice?: string;
  error?: SetuprError;
}

interface UpdateLayoutProps {
  scan: ScanResult;
  cwd: string;
}

interface UpdateLayoutGeometry {
  width: number;
  height: number;
  stacked: boolean;
  bodyHeight: number;
  summaryHeight: number;
  mainHeight: number;
  mainWidth: number;
  sideWidth: number;
  summaryWidths: number[];
  inputMaxLines: number;
  inputHeight: number;
  inputBounds: FocusBounds;
}

export function UpdateLayout({ scan, cwd }: UpdateLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildUpdateLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildUpdateFocusItems(layout), [layout]), onQuit: () => exit() });
  const [packages, setPackages] = useState<OutdatedPkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<SetuprError | null>(null);
  const { chatEvents, handleChat, pending: aiPending, label: aiLabel } = usePanelChat({
    scan,
    command: "update",
    context: `Outdated packages: ${packages.map((pkg) => `${pkg.name}: ${pkg.current}→${pkg.latest} (${pkg.type})`).join(", ") || "none"}`,
  });
  const noProject = !hasProjectSignals(scan);

  useEffect(() => {
    checkOutdated(scan, cwd, noProject).then((result) => {
      setPackages(result.packages);
      setNotice(result.notice || null);
      setError(result.error || null);
      setLoading(false);
    });
  }, []);

  const counts = packageCounts(packages);
  const risk = counts.major > 0 ? "High" : counts.minor > 0 ? "Medium" : counts.patch > 0 ? "Low" : "Clean";

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr update" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader
        command="setupr update"
        cwd={cwd}
        stack={buildStack(scan)}
        status={noProject ? "no project" : loading ? "scanning" : `${packages.length} outdated`}
        statusColor={noProject || error ? colors.warning : statusColor(risk)}
        right={noProject ? "no project" : `Risk ${risk}`}
        width={terminal.width}
      />

      {layout.stacked ? (
        <StackedUpdate
          layout={layout}
          packages={packages}
          counts={counts}
          risk={risk}
          loading={loading}
          notice={notice}
          error={error}
          noProject={noProject}
          scan={scan}
          chatEvents={chatEvents}
          aiPending={aiPending}
          aiLabel={aiLabel}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onChat={handleChat}
        />
      ) : (
        <WideUpdate
          layout={layout}
          packages={packages}
          counts={counts}
          risk={risk}
          loading={loading}
          notice={notice}
          error={error}
          noProject={noProject}
          scan={scan}
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
        left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Enter ask/confirm · q quit outside input"
        right={loading ? "checking..." : `${packages.length} outdated`}
      />
    </Box>
  );
}

function WideUpdate(props: UpdateViewProps) {
  const sideUsableHeight = Math.max(8, props.layout.mainHeight - tuiLayout.panelGap);
  const riskHeight = Math.max(8, Math.floor(sideUsableHeight * 0.54));
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width="100%" height={props.layout.summaryHeight} gap={tuiLayout.panelGap}>
        <Panel title="Major" focusState={props.focus("major")} width={props.layout.summaryWidths[0]} height="100%">
          <MetricText value={props.counts.major} label="packages" color={props.counts.major ? colors.error : colors.success} />
        </Panel>
        <Panel title="Minor" focusState={props.focus("minor")} width={props.layout.summaryWidths[1]} height="100%">
          <MetricText value={props.counts.minor} label="packages" color={props.counts.minor ? colors.warning : colors.success} />
        </Panel>
        <Panel title="Patch" focusState={props.focus("patch")} width={props.layout.summaryWidths[2]} height="100%">
          <MetricText value={props.counts.patch} label="packages" color={props.counts.patch ? colors.accent : colors.success} />
        </Panel>
        <Panel title="Security" focusState={props.focus("security")} width={props.layout.summaryWidths[3]} height="100%">
          <MetricText value={props.counts.major > 0 ? "review" : "ok"} label="risk gate" color={props.counts.major > 0 ? colors.error : colors.success} />
        </Panel>
      </Box>
      <Box flexDirection="row" width="100%" flexGrow={1} minHeight={8} gap={tuiLayout.panelGap}>
        <PackagesPanel {...props} width={props.layout.mainWidth} height="100%" />
        <Box flexDirection="column" width={props.layout.sideWidth} height="100%" gap={tuiLayout.panelGap}>
          <Panel title="Breaking Risks" focusState={props.focus("risks")} width="100%" height={riskHeight}>
            <RiskPanel {...props} />
          </Panel>
          <Panel title="Notices" focusState={props.focus("notices")} width="100%" flexGrow={1} minHeight={6}>
            <NoticePanel {...props} />
          </Panel>
        </Box>
      </Box>
    </Box>
  );
}

function StackedUpdate(props: UpdateViewProps) {
  const { summaryHeight, packageHeight, sideHeight } = stackedUpdateHeights(props.layout.bodyHeight);
  const third = Math.floor((props.layout.width - tuiLayout.panelGap * 2) / 3);
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width="100%" height={summaryHeight} gap={tuiLayout.panelGap}>
        <Panel title="Major" focusState={props.focus("major")} width={third} height="100%">
          <MetricText value={props.counts.major} label="major" color={props.counts.major ? colors.error : colors.success} />
        </Panel>
        <Panel title="Minor" focusState={props.focus("minor")} width={third} height="100%">
          <MetricText value={props.counts.minor} label="minor" color={props.counts.minor ? colors.warning : colors.success} />
        </Panel>
        <Panel title="Patch" focusState={props.focus("patch")} width={props.layout.width - third * 2 - tuiLayout.panelGap * 2} height="100%">
          <MetricText value={props.counts.patch} label="patch" color={props.counts.patch ? colors.accent : colors.success} />
        </Panel>
      </Box>
      <PackagesPanel {...props} width={props.layout.width} height={packageHeight} />
      <Panel title="Risks + Notices" focusState={props.focus("risks")} width="100%" height={sideHeight}>
        <RiskPanel {...props} compact />
      </Panel>
    </Box>
  );
}

function PackagesPanel({
  layout,
  packages,
  loading,
  notice,
  error,
  noProject,
  chatEvents,
  aiPending,
  aiLabel,
  inputActive,
  inputBounds,
  focus,
  onChat,
  width,
  height,
}: UpdateViewProps & { width: number; height: number | string }) {
  const chatRows = chatEvents.length ? Math.max(1, Math.min(8, Math.floor((layout.mainHeight - layout.inputHeight - 3) / 2))) : 0;
  const packageLimit = Math.max(1, layout.mainHeight - layout.inputMaxLines - 7 - chatRows);
  return (
    <Panel title={`Outdated Packages (${packages.length})`} focusState={focus("packages")} width={width} height={height}>
      <Box flexDirection="column" flexGrow={1} minHeight={0}>
        <Box flexDirection="column" flexGrow={1} minHeight={0} overflow="hidden">
          <Box flexDirection="column" flexShrink={0}>
          {packages.length > 0 && <TableHeader />}
          {loading && (
            <>
              {pendingUpdateRows().slice(0, packageLimit).map((row) => (
                <Text key={row} color={colors.textDim} wrap="truncate">⠋ {row}</Text>
              ))}
              <Spinner label="Checking for updates..." />
            </>
          )}
          {!loading && noProject && <Text color={colors.warning}>{icons.warning} {error?.title || "No project files detected in this directory."}</Text>}
          {!loading && error && <ErrorBlock error={error} />}
          {!loading && notice && <Text color={colors.warning}>{icons.warning} {notice}</Text>}
          {!loading && !noProject && !notice && !error && packages.length === 0 && <Text color={colors.success}>{icons.check} All dependencies up to date.</Text>}
          {packages.slice(0, packageLimit).map((pkg) => <PackageRow key={pkg.name} pkg={pkg} />)}
          {packages.length > packageLimit && <Text color={colors.textDim}>… and {packages.length - packageLimit} more</Text>}
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
          placeholder="Proceed with update? Ask about risk, or type a package name..."
          width={Math.max(12, width - 4)}
          maxLines={layout.inputMaxLines}
          scrollBounds={inputBounds}
        />
      </Box>
    </Panel>
  );
}

function RiskPanel({ packages, counts, risk, scan, compact = false }: UpdateViewProps & { compact?: boolean }) {
  return (
    <Box flexDirection="column">
      <KVRow label="Risk" value={risk} color={statusColor(risk)} />
      <KVRow label="PM" value={scan.packageManager || "none"} />
      <KVRow label="Total deps" value={scan.dependencies.prod + scan.dependencies.dev} />
      {counts.major > 0 && <Text color={colors.error} wrap="truncate">● Read release notes before major updates.</Text>}
      {counts.minor > 0 && <Text color={colors.warning} wrap="truncate">△ Minor updates may require config changes.</Text>}
      {!compact && packages.filter((pkg) => pkg.type === "major").slice(0, 4).map((pkg) => (
        <Text key={pkg.name} color={colors.error} wrap="truncate">· {pkg.name}: {pkg.current} → {pkg.latest}</Text>
      ))}
    </Box>
  );
}

function NoticePanel({ notice, error }: UpdateViewProps) {
  return (
    <Box flexDirection="column">
      {error && <Text color={colors.error} wrap="truncate">● {error.code}</Text>}
      {notice && <Text color={colors.warning} wrap="truncate">△ {notice}</Text>}
      {!error && !notice && <Text color={colors.textDim}>No blocking notices.</Text>}
    </Box>
  );
}

function TableHeader() {
  return (
    <Box justifyContent="space-between" width="100%" minWidth={0}>
      <Box flexShrink={0} marginRight={1}>
        <Text color={colors.heading}>PACKAGE</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={colors.heading} wrap="truncate">CURRENT → LATEST  TYPE</Text>
      </Box>
    </Box>
  );
}

function pendingUpdateRows(): string[] {
  return [
    "Reading package manifest and lockfile",
    "Detecting package manager strategy",
    "Checking direct dependencies",
    "Checking development dependencies",
    "Estimating major/minor/patch risk",
    "Preparing update safety review",
  ];
}

function PackageRow({ pkg }: { pkg: OutdatedPkg }) {
  return (
    <Box justifyContent="space-between" minWidth={0}>
      <Box flexShrink={1} minWidth={0}>
        <Text color={getTypeColor(pkg.type)}>{pkg.type === "major" ? icons.warning : icons.dot}</Text>
        <Text color={colors.text} wrap="truncate"> {pkg.name}</Text>
      </Box>
      <Box flexShrink={0}>
        <Text color={colors.textDim}>{pkg.current} → </Text>
        <Text color={getTypeColor(pkg.type)}>{pkg.latest}</Text>
        <Text color={colors.textDim}> {pkg.type}</Text>
      </Box>
    </Box>
  );
}

function ErrorBlock({ error }: { error: SetuprError }) {
  return (
    <Box flexDirection="column">
      <Text color={error.severity === "info" ? colors.info : colors.warning}>{icons.warning} {error.code}</Text>
      <Text color={colors.text}>{error.explanation}</Text>
      {error.details?.slice(0, 3).map((detail, index) => (
        <Text key={index} color={colors.textDim} wrap="truncate">  {detail}</Text>
      ))}
    </Box>
  );
}

export function buildUpdateLayout(width: number, height: number): UpdateLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 108 || bodyHeight < 22;
  const gap = tuiLayout.panelGap;
  const stackedHeights = stacked ? stackedUpdateHeights(bodyHeight) : null;
  const summaryHeight = stacked ? stackedHeights!.summaryHeight : clamp(Math.floor(bodyHeight * 0.22), 6, 8);
  const mainHeight = stacked
    ? stackedHeights!.packageHeight
    : Math.max(8, bodyHeight - summaryHeight - gap);
  const sideWidth = stacked ? width : clamp(Math.floor(width * 0.30), 34, 48);
  const mainWidth = stacked ? width : Math.max(8, width - sideWidth - gap);
  const summaryWidths = distributeWidths(Math.max(1, width - gap * 3), [1, 1, 1, 1], [18, 18, 18, 18]);
  const inputMaxLines = Math.max(1, Math.min(6, Math.floor(mainHeight / 4)));
  const inputHeight = inputMaxLines + 2;
  const mainY = 2 + summaryHeight + gap;
  const inputBounds = { x: 3, y: Math.max(4, mainY + mainHeight - inputHeight - 1), width: Math.max(8, mainWidth - 6), height: inputHeight };
  return { width, height, stacked, bodyHeight, summaryHeight, mainHeight, mainWidth, sideWidth, summaryWidths, inputMaxLines, inputHeight, inputBounds };
}

export function buildUpdateFocusItems(layout: UpdateLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    const { summaryHeight, packageHeight, sideHeight } = stackedUpdateHeights(layout.bodyHeight);
    const third = Math.floor((layout.width - tuiLayout.panelGap * 2) / 3);
    return [
      { id: "major", row: 0, column: 0, bounds: { x: 1, y: 2, width: third, height: summaryHeight } },
      { id: "minor", row: 0, column: 1, bounds: { x: third + tuiLayout.panelGap + 1, y: 2, width: third, height: summaryHeight } },
      { id: "patch", row: 0, column: 2, bounds: { x: third * 2 + tuiLayout.panelGap * 2 + 1, y: 2, width: layout.width - third * 2 - tuiLayout.panelGap * 2, height: summaryHeight } },
      { id: "packages", row: 1, column: 0, redirectTo: "input", bounds: { x: 1, y: 2 + summaryHeight + tuiLayout.panelGap, width: layout.width, height: packageHeight } },
      { id: "input", row: 2, column: 0, parentIds: ["packages"], bounds: layout.inputBounds },
      { id: "risks", row: 3, column: 0, bounds: { x: 1, y: 2 + summaryHeight + packageHeight + tuiLayout.panelGap * 2, width: layout.width, height: sideHeight } },
    ];
  }
  let x = 1;
  const items: FocusItem[] = ["major", "minor", "patch", "security"].map((id, index) => {
    const item = { id, row: 0, column: index, bounds: { x, y: 2, width: layout.summaryWidths[index], height: layout.summaryHeight } };
    x += layout.summaryWidths[index] + tuiLayout.panelGap;
    return item;
  });
  const mainY = 2 + layout.summaryHeight + tuiLayout.panelGap;
  items.push({ id: "packages", row: 1, column: 0, redirectTo: "input", bounds: { x: 1, y: mainY, width: layout.mainWidth, height: layout.mainHeight } });
  items.push({ id: "input", row: 2, column: 0, parentIds: ["packages"], bounds: layout.inputBounds });
  const sideUsableHeight = Math.max(8, layout.mainHeight - tuiLayout.panelGap);
  const riskHeight = Math.max(8, Math.floor(sideUsableHeight * 0.54));
  items.push({ id: "risks", row: 1, column: 1, bounds: { x: layout.mainWidth + tuiLayout.panelGap + 1, y: mainY, width: layout.sideWidth, height: riskHeight } });
  items.push({ id: "notices", row: 2, column: 1, bounds: { x: layout.mainWidth + tuiLayout.panelGap + 1, y: mainY + riskHeight + tuiLayout.panelGap, width: layout.sideWidth, height: Math.max(6, sideUsableHeight - riskHeight) } });
  return items;
}

interface UpdateViewProps {
  layout: UpdateLayoutGeometry;
  packages: OutdatedPkg[];
  counts: { major: number; minor: number; patch: number };
  risk: string;
  loading: boolean;
  notice: string | null;
  error: SetuprError | null;
  noProject: boolean;
  scan: ScanResult;
  chatEvents: TimelineEvent[];
  aiPending: boolean;
  aiLabel: string;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  inputActive: boolean;
  inputBounds?: FocusBounds;
  onChat: (text: string) => void;
}

async function checkOutdated(scan: ScanResult, cwd: string, noProject: boolean): Promise<UpdateResult> {
  if (noProject) {
    return { packages: [], error: createSetuprError({ code: "NO_PROJECT_DETECTED", command: "update", cwd, canContinue: false }) };
  }
  if (!scan.packageManager) {
    return { packages: [], error: createSetuprError({ code: "MISSING_PACKAGE_MANAGER", command: "update", cwd, details: ["No npm, yarn, pnpm, bun, pip, cargo, or go package manager was detected."] }) };
  }
  const pm = scan.packageManager;
  const abortController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, 12_000);

  try {
    const result = await runCommand(`${pm} outdated --json 2>/dev/null`, cwd, undefined, abortController.signal);
    if (timedOut) {
      return { packages: [], error: createSetuprError({ code: "COMMAND_TIMEOUT", command: "update", cwd, details: [`Command: ${pm} outdated --json`] }) };
    }
    const raw = result.stdout || result.stderr || "{}";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return result.exitCode === 0
        ? { packages: [] }
        : {
            packages: [],
            error: classifyCommandFailure({
              command: `${pm} outdated --json`,
              cwd,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              stepLabel: "Dependency update check",
              stepType: "deps",
            }),
          };
    }
    const data = JSON.parse(jsonMatch[0]);
    return {
      packages: Object.entries(data).map(([name, info]: [string, any]) => ({
        name,
        current: info.current || "?",
        latest: info.latest || info.wanted || "?",
        type: classifyUpdate(info.current || "0.0.0", info.latest || info.wanted || "0.0.0"),
      })),
    };
  } catch (err) {
    return { packages: [], error: fromUnknownError(err, { command: "update", cwd }) };
  } finally {
    clearTimeout(timer);
  }
}

function classifyUpdate(current: string, latest: string): "major" | "minor" | "patch" {
  const curr = current.replace(/[^0-9.]/g, "").split(".");
  const lat = latest.replace(/[^0-9.]/g, "").split(".");
  if (curr[0] !== lat[0]) return "major";
  if (curr[1] !== lat[1]) return "minor";
  return "patch";
}

function getTypeColor(type: OutdatedPkg["type"]): string {
  switch (type) {
    case "major": return colors.error;
    case "minor": return colors.warning;
    case "patch": return colors.success;
  }
}

function packageCounts(packages: OutdatedPkg[]) {
  return {
    major: packages.filter((pkg) => pkg.type === "major").length,
    minor: packages.filter((pkg) => pkg.type === "minor").length,
    patch: packages.filter((pkg) => pkg.type === "patch").length,
  };
}

function buildStack(scan: ScanResult): string {
  return [scan.framework, scan.language, scan.packageManager].filter(Boolean).join(" + ") || "unknown";
}

function stackedUpdateHeights(bodyHeight: number) {
  const available = Math.max(8, bodyHeight - tuiLayout.panelGap * 2);
  const summaryHeight = bodyHeight < 22 ? 5 : Math.max(6, Math.floor(bodyHeight * 0.24));
  const sideHeight = bodyHeight < 22 ? 5 : Math.max(7, Math.floor(bodyHeight * 0.25));
  return {
    summaryHeight,
    sideHeight,
    packageHeight: Math.max(4, available - summaryHeight - sideHeight),
  };
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
