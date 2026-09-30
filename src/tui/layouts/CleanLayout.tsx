import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp } from "ink";
import { rm, stat } from "fs/promises";
import { join } from "path";
import { createSetuprError, type SetuprError } from "../../errors/index.js";
import type { ScanResult } from "../../scanner/index.js";
import { ChatInput } from "../components/ChatInput.js";
import { Panel } from "../components/Panel.js";
import { Spinner } from "../components/Spinner.js";
import { KVRow, MetricText, TooSmallTerminal, TuiFooter, TuiHeader, isTerminalTooSmall, statusColor } from "../components/TuiFrame.js";
import { useFocusNavigation, type FocusBounds, type FocusItem } from "../hooks/useFocusNavigation.js";
import { useTerminalSize } from "../hooks/useTerminalSize.js";
import { colors, icons, layout as tuiLayout } from "../theme.js";

interface CleanTarget {
  path: string;
  size: string;
  bytes: number;
  type: "deps" | "build" | "cache" | "sensitive";
  status: "pending" | "removing" | "done" | "failed";
  error?: SetuprError;
}

interface CleanLayoutProps {
  scan: ScanResult;
  cwd: string;
  mode: "deps" | "share" | "all";
  force?: boolean;
}

interface CleanLayoutGeometry {
  width: number;
  height: number;
  stacked: boolean;
  bodyHeight: number;
  targetsWidth: number;
  reviewWidth: number;
  riskWidth: number;
  inputMaxLines: number;
  inputHeight: number;
  inputBounds: FocusBounds;
}

type CleanPhase = "scanning" | "review" | "cleaning" | "done" | "blocked";

export function CleanLayout({ cwd, mode, force = false }: CleanLayoutProps) {
  const { exit } = useApp();
  const terminal = useTerminalSize();
  const layout = useMemo(() => buildCleanLayout(terminal.width, terminal.height), [terminal.width, terminal.height]);
  const focus = useFocusNavigation({ items: useMemo(() => buildCleanFocusItems(layout), [layout]), onQuit: () => exit() });
  const [targets, setTargets] = useState<CleanTarget[]>([]);
  const [phase, setPhase] = useState<CleanPhase>("scanning");
  const [message, setMessage] = useState(force ? "Force mode: cleaning after scan." : "Review targets before deleting anything.");

  useEffect(() => {
    let alive = true;
    findCleanTargets(cwd, mode).then((found) => {
      if (!alive) return;
      setTargets(found);
      if (found.length === 0) {
        setPhase("done");
        setMessage("Nothing to clean.");
        return;
      }
      if (force) {
        setPhase("cleaning");
        cleanTargets(cwd, found).then((results) => {
          if (!alive) return;
          setTargets(results);
          setPhase("done");
          setMessage("Force mode cleaned the listed targets.");
        });
      } else {
        setPhase("review");
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const handleConfirm = async (text: string) => {
    const normalized = text.trim().toLowerCase();
    if (phase !== "review") return;
    if (normalized !== "clean" && normalized !== "yes" && normalized !== "y") {
      setPhase("blocked");
      setMessage('Not cleaned. Type "CLEAN" to confirm deletion, or press q to quit.');
      return;
    }
    setPhase("cleaning");
    setMessage("Cleaning selected targets...");
    const results = await cleanTargets(cwd, targets);
    setTargets(results);
    setPhase("done");
    setMessage(results.some((target) => target.status === "failed") ? "Clean finished with failures." : "Clean complete.");
  };

  const totalBytes = targets.reduce((sum, target) => sum + target.bytes, 0);
  const failed = targets.filter((target) => target.status === "failed").length;
  const risk = mode === "all" ? "High" : mode === "share" ? "High" : "Medium";

  if (isTerminalTooSmall(terminal.width, terminal.height)) {
    return <TooSmallTerminal command="setupr clean" width={terminal.width} height={terminal.height} />;
  }

  return (
    <Box flexDirection="column" width={terminal.width} height={terminal.height}>
      <TuiHeader
        command={`setupr clean ${mode}`}
        cwd={cwd}
        status={phase}
        statusColor={phase === "done" ? colors.success : phase === "blocked" ? colors.warning : statusColor(risk)}
        right={`Risk ${risk}`}
        width={terminal.width}
      />

      {layout.stacked ? (
        <StackedClean
          layout={layout}
          targets={targets}
          phase={phase}
          mode={mode}
          message={message}
          totalBytes={totalBytes}
          failed={failed}
          risk={risk}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onConfirm={handleConfirm}
        />
      ) : (
        <WideClean
          layout={layout}
          targets={targets}
          phase={phase}
          mode={mode}
          message={message}
          totalBytes={totalBytes}
          failed={failed}
          risk={risk}
          focus={focus.focusState}
          inputActive={focus.isActive("input")}
          inputBounds={focus.activeItem?.id === "input" ? focus.activeItem.bounds : undefined}
          onConfirm={handleConfirm}
        />
      )}

      <TuiFooter
        width={terminal.width}
        left="Ctrl+C abort · Tab next panel · ←/↑/↓/→ navigate · Type CLEAN confirm · q quit outside input"
        right={`${targets.length} targets · ${formatSize(totalBytes)}`}
      />
    </Box>
  );
}

function WideClean(props: CleanViewProps) {
  const panelHeight = Math.max(6, props.layout.bodyHeight - props.layout.inputHeight - tuiLayout.panelGap);
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Box flexDirection="row" width="100%" height={panelHeight} gap={tuiLayout.panelGap}>
        <Panel title="Targets" focusState={props.focus("targets")} width={props.layout.targetsWidth} height="100%">
          <TargetsPanel {...props} limit={panelHeight - 3} />
        </Panel>
        <Panel title="Safety Review" focusState={props.focus("review")} width={props.layout.reviewWidth} height="100%">
          <SafetyPanel {...props} />
        </Panel>
        <Panel title="Risk Summary" focusState={props.focus("risk")} width={props.layout.riskWidth} height="100%">
          <RiskPanel {...props} />
        </Panel>
      </Box>
      <CleanCommandStrip {...props} width={props.layout.width} />
    </Box>
  );
}

function StackedClean(props: CleanViewProps) {
  const { targetsHeight, reviewHeight, riskHeight } = stackedCleanHeights(props.layout.bodyHeight, props.layout.inputHeight);
  return (
    <Box flexDirection="column" width={props.layout.width} height={props.layout.bodyHeight} gap={tuiLayout.panelGap}>
      <Panel title="Targets" focusState={props.focus("targets")} width="100%" height={targetsHeight}>
        <TargetsPanel {...props} limit={targetsHeight - 3} />
      </Panel>
      <Panel title="Safety Review" focusState={props.focus("review")} width="100%" height={reviewHeight}>
        <SafetyPanel {...props} />
      </Panel>
      <Panel title="Risk Summary" focusState={props.focus("risk")} width="100%" height={riskHeight}>
        <RiskPanel {...props} compact />
      </Panel>
      <CleanCommandStrip {...props} width={props.layout.width} />
    </Box>
  );
}

function TargetsPanel({ targets, phase, limit = 12 }: CleanViewProps & { limit?: number }) {
  return (
    <Box flexDirection="column">
      {phase === "scanning" && <Spinner label="Scanning for removable files..." />}
      {targets.slice(0, Math.max(1, limit)).map((target) => (
        <Box key={target.path} minWidth={0} justifyContent="space-between">
          <Box minWidth={0} flexShrink={1}>
            <Text color={getTargetColor(target)} wrap="truncate">
              {target.status === "done" ? icons.check : target.status === "failed" ? icons.cross : target.status === "removing" ? icons.spinner[0] : icons.circle}
              {" "}{target.path}
            </Text>
          </Box>
          <Text color={colors.textDim}> {target.size}</Text>
        </Box>
      ))}
      {targets.length > limit && <Text color={colors.textDim}>… {targets.length - limit} more targets</Text>}
      {phase !== "scanning" && targets.length === 0 && <Text color={colors.success}>{icons.check} Nothing to clean.</Text>}
    </Box>
  );
}

function SafetyPanel({ mode, phase, message, targets }: CleanViewProps) {
  const willDelete = targets.filter((target) => target.status === "pending" || target.status === "removing").length;
  return (
    <Box flexDirection="column" flexGrow={1} minHeight={0}>
      <Box flexDirection="column" flexGrow={1}>
        <Text color={colors.heading} bold>WHAT WILL BE DELETED</Text>
        <Text color={colors.text} wrap="truncate">{modeDescription(mode)}</Text>
        <Text color={colors.heading} bold>WHAT WILL BE PROTECTED</Text>
        <Text color={colors.textDim} wrap="truncate">Source code, git history, and tracked config files are not targeted.</Text>
        <Text color={phase === "blocked" ? colors.warning : phase === "done" ? colors.success : colors.text} wrap="truncate">{message}</Text>
        <KVRow label="Pending targets" value={willDelete} color={willDelete > 0 ? colors.warning : colors.success} />
      </Box>
    </Box>
  );
}

function CleanCommandStrip({ layout, phase, inputActive, inputBounds, focus, onConfirm, width }: CleanViewProps & { width: number }) {
  const disabled = phase !== "review" && phase !== "blocked";
  const placeholder = phase === "blocked"
    ? 'Type CLEAN to confirm, or q to quit...'
    : phase === "done"
      ? "Clean finished. Press q outside input to quit."
      : "Type CLEAN to confirm deletion...";
  return (
    <Box width="100%" height={layout.inputHeight} flexShrink={0} justifyContent="center" alignItems="center">
      <ChatInput
        active={inputActive}
        focusState={focus("input")}
        onSubmit={onConfirm}
        placeholder={placeholder}
        width={Math.max(12, width - 2)}
        maxLines={layout.inputMaxLines}
        scrollBounds={inputBounds}
        disabled={disabled}
        busy={phase === "cleaning"}
        disabledText={placeholder}
      />
    </Box>
  );
}

function RiskPanel({ phase, risk, failed, totalBytes, targets, compact = false }: CleanViewProps & { compact?: boolean }) {
  if (compact) return <Text wrap="truncate" color={statusColor(risk)}>{risk} · {formatSize(totalBytes)} · {phase} · {failed} failed</Text>;
  return (
    <Box flexDirection="column">
      <MetricText value={formatSize(totalBytes)} label="estimated space" color={totalBytes > 0 ? colors.error : colors.success} />
      <KVRow label="Risk level" value={risk} color={statusColor(risk)} />
      <KVRow label="Phase" value={phase} color={statusColor(phase)} />
      <KVRow label="Failed" value={failed} color={failed > 0 ? colors.error : colors.success} />
      {!compact && targets.filter((target) => target.type === "sensitive").slice(0, 4).map((target) => (
        <Text key={target.path} color={colors.error} wrap="truncate">● sensitive: {target.path}</Text>
      ))}
      {!compact && <Text color={colors.textDim} wrap="wrap">This action is irreversible unless the files are backed up elsewhere.</Text>}
    </Box>
  );
}

export function buildCleanLayout(width: number, height: number): CleanLayoutGeometry {
  const bodyHeight = Math.max(8, height - 2);
  const stacked = width < 106 || bodyHeight < 22;
  const gap = tuiLayout.panelGap;
  const targetsWidth = stacked ? width : clamp(Math.floor(width * 0.30), 28, 42);
  const riskWidth = stacked ? width : clamp(Math.floor(width * 0.27), 28, 40);
  const reviewWidth = stacked ? width : Math.max(8, width - targetsWidth - riskWidth - gap * 2);
  const inputMaxLines = stacked ? 1 : Math.max(1, Math.min(4, Math.floor(bodyHeight / 6)));
  const inputHeight = inputMaxLines + 2;
  const inputBounds = {
    x: stacked ? 3 : 3,
    y: Math.max(4, height - inputHeight - 1),
    width: Math.max(8, stacked ? width - 6 : width - 6),
    height: inputHeight,
  };
  return { width, height, stacked, bodyHeight, targetsWidth, reviewWidth, riskWidth, inputMaxLines, inputHeight, inputBounds };
}

export function buildCleanFocusItems(layout: CleanLayoutGeometry): FocusItem[] {
  if (layout.stacked) {
    const { targetsHeight, reviewHeight, riskHeight } = stackedCleanHeights(layout.bodyHeight, layout.inputHeight);
    return [
      { id: "targets", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.width, height: targetsHeight } },
      { id: "review", row: 1, column: 0, redirectTo: "input", bounds: { x: 1, y: 2 + targetsHeight + tuiLayout.panelGap, width: layout.width, height: reviewHeight } },
      { id: "input", row: 2, column: 0, parentIds: ["review"], bounds: layout.inputBounds },
      { id: "risk", row: 3, column: 0, bounds: { x: 1, y: 2 + targetsHeight + reviewHeight + tuiLayout.panelGap * 2, width: layout.width, height: riskHeight } },
    ];
  }
  return [
    { id: "targets", row: 0, column: 0, bounds: { x: 1, y: 2, width: layout.targetsWidth, height: layout.bodyHeight - layout.inputHeight - tuiLayout.panelGap } },
    { id: "review", row: 0, column: 1, redirectTo: "input", bounds: { x: layout.targetsWidth + tuiLayout.panelGap + 1, y: 2, width: layout.reviewWidth, height: layout.bodyHeight - layout.inputHeight - tuiLayout.panelGap } },
    { id: "input", row: 1, column: 1, parentIds: ["review"], bounds: layout.inputBounds },
    { id: "risk", row: 0, column: 2, bounds: { x: layout.targetsWidth + layout.reviewWidth + tuiLayout.panelGap * 2 + 1, y: 2, width: layout.riskWidth, height: layout.bodyHeight - layout.inputHeight - tuiLayout.panelGap } },
  ];
}

function stackedCleanHeights(bodyHeight: number, inputHeight: number) {
  const available = Math.max(8, bodyHeight - inputHeight - tuiLayout.panelGap * 3);
  if (bodyHeight < 22) {
    const targetsHeight = Math.max(4, Math.floor(available * 0.42));
    const reviewHeight = Math.max(3, Math.floor(available * 0.34));
    return {
      targetsHeight,
      reviewHeight,
      riskHeight: Math.max(2, available - targetsHeight - reviewHeight),
    };
  }
  const targetsHeight = Math.max(4, Math.floor((available - 4) / 2));
  const reviewHeight = Math.max(4, available - targetsHeight - 4);
  return {
    targetsHeight,
    reviewHeight,
    riskHeight: Math.max(4, available - targetsHeight - reviewHeight),
  };
}

interface CleanViewProps {
  layout: CleanLayoutGeometry;
  targets: CleanTarget[];
  phase: CleanPhase;
  mode: "deps" | "share" | "all";
  message: string;
  totalBytes: number;
  failed: number;
  risk: string;
  focus: (id: string) => "focused" | "ancestor" | undefined;
  inputActive: boolean;
  inputBounds?: FocusBounds;
  onConfirm: (text: string) => void;
}

async function findCleanTargets(cwd: string, mode: string): Promise<CleanTarget[]> {
  const targets: CleanTarget[] = [];
  const depsDirs = ["node_modules", "__pycache__", "venv", ".venv", "vendor", "target/debug"];
  const buildDirs = ["dist", "build", ".next", ".nuxt", ".output", "out"];
  const cacheDirs = [".cache", ".turbo", ".parcel-cache", ".vite"];
  const sensitiveFiles = [".env", ".env.local", ".DS_Store", "*.log"];

  if (mode === "deps" || mode === "all") {
    for (const dir of depsDirs) {
      const info = await getPathSize(join(cwd, dir));
      if (info) targets.push({ path: dir, size: info.size, bytes: info.bytes, type: "deps", status: "pending" });
    }
  }
  if (mode === "all") {
    for (const dir of [...buildDirs, ...cacheDirs]) {
      const info = await getPathSize(join(cwd, dir));
      if (info) targets.push({ path: dir, size: info.size, bytes: info.bytes, type: "build", status: "pending" });
    }
  }
  if (mode === "share" || mode === "all") {
    for (const file of sensitiveFiles) {
      if (!file.includes("*")) {
        const info = await getPathSize(join(cwd, file));
        if (info) targets.push({ path: file, size: info.size, bytes: info.bytes, type: "sensitive", status: "pending" });
      }
    }
  }
  return targets;
}

async function cleanTargets(cwd: string, targets: CleanTarget[]): Promise<CleanTarget[]> {
  const results = [...targets];
  for (let index = 0; index < results.length; index++) {
    results[index] = { ...results[index], status: "removing" };
    try {
      await rm(join(cwd, results[index].path), { recursive: true, force: true });
      results[index] = { ...results[index], status: "done" };
    } catch (err) {
      results[index] = {
        ...results[index],
        status: "failed",
        error: createSetuprError({
          code: "CLEAN_TARGET_FAILED",
          command: "clean",
          cwd,
          details: [`Target: ${results[index].path}`, err instanceof Error ? err.message : String(err)],
        }),
      };
    }
  }
  return results;
}

async function getPathSize(path: string): Promise<{ size: string; bytes: number } | null> {
  try {
    const item = await stat(path);
    const bytes = item.isDirectory() ? item.size || 4096 : item.size;
    return { size: formatSize(bytes), bytes };
  } catch {
    return null;
  }
}

function modeDescription(mode: "deps" | "share" | "all"): string {
  if (mode === "deps") return "Dependency folders and dependency caches.";
  if (mode === "share") return "Local sensitive and machine-specific files.";
  return "Dependencies, build outputs, caches, and local env files.";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function getTargetColor(target: CleanTarget): string {
  if (target.status === "done") return colors.success;
  if (target.status === "failed") return colors.error;
  if (target.status === "removing") return colors.accent;
  return target.type === "sensitive" ? colors.warning : colors.text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
