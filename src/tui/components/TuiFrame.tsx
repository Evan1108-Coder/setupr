import React from "react";
import { Box, Text } from "ink";
import { colors, icons, shortcuts } from "../theme.js";
import { Panel } from "./Panel.js";

export const MIN_TUI_WIDTH = 60;
export const MIN_TUI_HEIGHT = 24;

export function isTerminalTooSmall(width: number, height: number): boolean {
  return width < MIN_TUI_WIDTH || height < MIN_TUI_HEIGHT;
}

export function TooSmallTerminal({ command, width, height }: { command: string; width: number; height: number }) {
  return (
    <Box flexDirection="column" width={width} height={height}>
      <TuiHeader command={command} title="terminal too small" status={`${width}x${height}`} statusColor={colors.warning} width={width} />
      <Box flexGrow={1} overflow="hidden">
        <Panel title="Resize Terminal" focusState="focused" width="100%" height="100%">
          <Text color={colors.warning} bold wrap="truncate">Terminal is too small for this TUI.</Text>
          <Text color={colors.textDim} wrap="truncate">
            Minimum supported size is {MIN_TUI_WIDTH}x{MIN_TUI_HEIGHT}. Current size is {width}x{height}.
          </Text>
          <Text color={colors.textDim} wrap="truncate">Enlarge the terminal or use --plain / --no-tui.</Text>
        </Panel>
      </Box>
      <TuiFooter width={width} left="Ctrl+C abort · resize terminal · --plain for non-interactive output" />
    </Box>
  );
}

interface TuiHeaderProps {
  command: string;
  title?: string;
  cwd?: string;
  stack?: string;
  status?: string;
  statusColor?: string;
  right?: string;
  width: number;
}

export function TuiHeader({ command, title, cwd, stack, status, statusColor, right, width }: TuiHeaderProps) {
  const compact = width < 118;
  const pathText = cwd ? shortPath(cwd, compact ? 18 : 28) : "";
  const leftText = compact
    ? `${icons.diamond} ${command}${title ? ` · ${title}` : ""}`
    : `${icons.diamond} ${command}${title ? `  ${title}` : ""}${stack ? `  Stack: ${stack}` : ""}${pathText ? `  ${pathText}` : ""}`;
  const rightText = right || status || "";
  const rightWidth = rightText ? Math.min(Math.max(8, width - 10), Math.max(8, displayWidth(rightText) + 3)) : 0;
  const leftWidth = Math.max(8, width - rightWidth - (rightWidth > 0 ? 1 : 0));

  return (
    <Box width="100%" height={1}>
      <Box width={leftWidth} minWidth={0} flexShrink={1}>
        <Text color={colors.primary} bold wrap="truncate">{leftText}</Text>
      </Box>
      {rightWidth > 0 && (
        <Box width={rightWidth} justifyContent="flex-end" flexShrink={0}>
          <Text color={statusColor || colors.textDim} bold={Boolean(statusColor)} wrap="truncate">{rightText}</Text>
        </Box>
      )}
    </Box>
  );
}

interface TuiFooterProps {
  width: number;
  left?: string;
  right?: string;
}

export function TuiFooter({ width, left, right }: TuiFooterProps) {
  const compact = width < 110;
  const leftText = left || (compact
    ? "Ctrl+C abort · Tab next · q quit"
    : shortcuts.map((shortcut) => `${shortcut.key} ${shortcut.desc}`).join(" · "));

  const rightWidth = right ? Math.min(Math.max(8, width - 10), Math.max(8, displayWidth(right) + 2)) : 0;
  const leftWidth = rightWidth > 0 ? Math.max(8, width - rightWidth - 1) : width;

  return (
    <Box width="100%" height={1}>
      <Box width={leftWidth} minWidth={0} flexShrink={1}>
        <Text color={colors.textDim} wrap="truncate">{leftText}</Text>
      </Box>
      {right && (
        <Box width={rightWidth} flexShrink={0} justifyContent="flex-end">
          <Text color={colors.textDim} wrap="truncate">{right}</Text>
        </Box>
      )}
    </Box>
  );
}

export function KVRow({ label, value, color, dim = false }: { label: string; value: string | number; color?: string; dim?: boolean }) {
  return (
    <Box justifyContent="space-between" width="100%" minWidth={0}>
      <Box flexShrink={0} marginRight={1}>
        <Text color={dim ? colors.textDim : colors.label}>{label}</Text>
      </Box>
      <Box flexShrink={1} minWidth={0}>
        <Text color={color || (dim ? colors.textDim : colors.value)} wrap="truncate">{String(value)}</Text>
      </Box>
    </Box>
  );
}

export function MetricText({ value, label, color }: { value: string | number; label: string; color?: string }) {
  return (
    <Box flexDirection="column">
      <Text color={color || colors.textBright} bold>{String(value)}</Text>
      <Text color={colors.textDim} wrap="truncate">{label}</Text>
    </Box>
  );
}

export function toneColor(tone?: "success" | "warning" | "error" | "info" | "muted") {
  if (tone === "success") return colors.success;
  if (tone === "warning") return colors.warning;
  if (tone === "error") return colors.error;
  if (tone === "muted") return colors.textDim;
  return colors.info;
}

export function statusColor(status: string | undefined) {
  const value = (status || "").toLowerCase();
  if (/\b(fail|error|crash|missing|high|invalid|blocked)\b/.test(value)) return colors.error;
  if (/\b(warn|moderate|pending|dirty|behind|timeout|skipped|in_use)\b/.test(value)) return colors.warning;
  if (/\b(pass|ok|good|ready|running|clean|saved|complete|free|loaded|synced)\b/.test(value)) return colors.success;
  return colors.text;
}

export function shortPath(cwd: string, max = 34): string {
  const home = process.env.HOME || "";
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (path.length <= max) return path;
  return `…${path.slice(Math.max(0, path.length - max + 1))}`;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) || 0;
    if (code === 0) continue;
    if (code < 32 || (code >= 0x7f && code < 0xa0)) continue;
    width += isWideCodePoint(code) ? 2 : 1;
  }
  return width;
}

function isWideCodePoint(code: number): boolean {
  return (
    code >= 0x1100 && (
      code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6)
    )
  );
}

export function formatAge(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(delta / 60000);
  if (minutes <= 0) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
