import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import stringWidth from "string-width";
import { createTerminalControlInputStripper, useTerminalInput } from "../terminalInput.js";
import { presentGrapheme } from "../textCells.js";
import { stripHiddenReasoning } from "../../ai/response.js";
import { colors, icons } from "../theme.js";
import { markdownRows, wrapStyled, type StyledSpan } from "../markdown.js";
import { terminalBounds } from "../terminalBounds.js";

export type TimelineEventKind =
  | "user"
  | "assistant"
  | "steer"
  | "system"
  | "thinking"
  | "log"
  | "notice"
  | "confirmation"
  | "question";

export type TimelineEventTone = "info" | "success" | "warning" | "error" | "muted";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  content: string;
  timestamp?: number;
  tone?: TimelineEventTone;
  title?: string;
  detail?: string;
  sensitive?: boolean;
}

interface TimelineProps {
  events: TimelineEvent[];
  maxItems?: number;
  width?: number;
  emptyText?: string;
  showTime?: boolean;
  active?: boolean;
  fill?: boolean;
}

export function Timeline({
  events,
  maxItems = 18,
  width = 80,
  emptyText = "Nothing here yet.",
  showTime = true,
  active = false,
  fill = false,
}: TimelineProps) {
  const element = useRef<DOMElement>(null);
  const controls = useRef(createTerminalControlInputStripper());
  const [scrollBack, setScrollBack] = useState(0);
  const [measuredRows, setMeasuredRows] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!fill) return;
    const height = terminalBounds(element.current)?.height;
    if (height !== undefined && height > 0) setMeasuredRows(current => current === Math.floor(height) ? current : Math.floor(height));
  });
  const maxRows = Math.max(1, fill && measuredRows !== null ? measuredRows : maxItems);
  const allRows = useMemo(() => events.flatMap((event) => eventRows(event, width, showTime)), [events, width, showTime]);
  const overflow = allRows.length > maxRows;
  const contentHeight = overflow && maxRows > 1 ? maxRows - 1 : maxRows;
  const maxScroll = Math.max(0, allRows.length - contentHeight);
  const offset = Math.min(scrollBack, maxScroll);
  const end = allRows.length - offset;
  const rows = allRows.slice(Math.max(0, end - contentHeight), end);

  useTerminalInput((_input, key, raw) => {
    const chunk = controls.current.read(raw);
    if (chunk.paste) return;
    for (const mouse of chunk.mouse) {
      if (mouse.action !== "scroll" || !containsPoint(element.current, mouse.x, mouse.y)) continue;
      setScrollBack(Math.max(0, Math.min(maxScroll, offset + ((mouse.code & 1) === 0 ? 3 : -3))));
    }
    if (active && (key.pageUp || key.pageDown)) {
      setScrollBack(Math.max(0, Math.min(maxScroll, offset + (key.pageUp ? contentHeight : -contentHeight))));
    }
  });

  return (
    <Box ref={element} flexDirection="column" flexGrow={1} flexBasis={fill ? 0 : undefined} minHeight={0} minWidth={0} overflow="hidden" justifyContent={fill ? "flex-end" : undefined}>
      {rows.length === 0 && <Text color={colors.textDim} italic>{emptyText}</Text>}
      {rows.map((row, index) => (
        <TimelineRow key={`${row.id}-${index}`} row={row} width={width} />
      ))}
      {overflow && maxRows > 1 && <Text color={colors.textDim} wrap="truncate">{offset ? `${offset} lines below` : "Latest"} · Scroll / PgUp/PgDn</Text>}
    </Box>
  );
}

function containsPoint(element: DOMElement | null, x: number, y: number): boolean {
  if (!element?.yogaNode) return false;
  let left = 1;
  let top = 1;
  for (let node: DOMElement | undefined = element; node; node = node.parentNode) {
    left += node.yogaNode?.getComputedLeft() || 0;
    top += node.yogaNode?.getComputedTop() || 0;
  }
  return x >= left && x < left + element.yogaNode.getComputedWidth()
    && y >= top && y < top + element.yogaNode.getComputedHeight();
}

interface TimelineRowData {
  id: string;
  text: string;
  color: string;
  isUser: boolean;
  bold?: boolean;
  spans?: StyledSpan[];
}

function TimelineRow({ row, width }: { row: TimelineRowData; width: number }) {
  const rowWidth = Math.max(1, width);
  const textWidth = Math.min(rowWidth, Math.max(1, stringWidth(row.text)));

  return (
    <Box width="100%" height={1} flexShrink={0} justifyContent={row.isUser ? "flex-end" : "flex-start"} minWidth={0}>
      <Box width={textWidth} minWidth={0}>
        <Text color={row.color} bold={row.bold} wrap="truncate">
          {row.spans ? row.spans.map((span, index) => <Text key={index} bold={span.bold} italic={span.italic} strikethrough={span.strikethrough} underline={span.underline} color={span.color}>{span.text}</Text>) : row.text}
        </Text>
      </Box>
    </Box>
  );
}

function eventRows(event: TimelineEvent, width: number, showTime: boolean): TimelineRowData[] {
  const style = eventStyle(event);
  const isUser = event.kind === "user";
  const content = event.sensitive ? maskValue(event.content)
    : event.kind === "assistant" ? stripHiddenReasoning(event.content) || "No visible answer was saved. Please retry this message."
    : event.content;
  const maxWidth = Math.max(1, width);
  const time = showTime && event.timestamp ? `${formatTime(event.timestamp)} ` : "";
  const title = event.title ? `${event.title}: ` : "";
  const prefix = isUser ? "You: " : `${style.prefix} `;
  const firstPrefix = `${prefix}${time}${title}`;
  const continuationPrefix = " ".repeat(Math.min(stringWidth(firstPrefix), 14, Math.floor(maxWidth / 4)));

  const richRows = event.kind === "assistant" && !event.sensitive
    ? markdownRows(content, maxWidth).flatMap((spans, index) => wrapStyled(index === 0 ? [{ text: firstPrefix, color: style.color }, ...spans] : spans, maxWidth, "  "))
    : wrapStyled([{ text: `${firstPrefix}${content}` }], maxWidth, continuationPrefix);
  const rows: TimelineRowData[] = richRows.map((spans) => ({
    id: event.id,
    text: spans.map(span => span.text).join(""),
    spans,
    color: style.textColor,
    isUser,
    bold: isUser || event.kind === "question" || event.kind === "confirmation",
  }));

  if (event.detail) {
    rows.push({
      id: `${event.id}-detail`,
      text: truncateText(`${continuationPrefix}${event.detail}`, maxWidth),
      color: colors.textDim,
      isUser,
      bold: false,
    });
  }

  return rows.length > 0 ? rows : [{
    id: event.id,
    text: firstPrefix.trimEnd(),
    color: style.textColor,
    isUser,
  }];
}

function wrapText(text: string, width: number, continuationPrefix: string): string[] {
  const rows: string[] = [];
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const safeText = createTerminalControlInputStripper().strip(text);
  for (const line of safeText.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let row = rows.length ? continuationPrefix : "";
    for (const { segment } of segmenter.segment(line)) {
      for (const { segment: piece } of segmenter.segment(presentGrapheme(segment))) {
        if (stringWidth(row + piece) > width) {
          rows.push(row);
          row = continuationPrefix;
        }
        row += stringWidth(piece) <= width - stringWidth(continuationPrefix) ? piece : "?";
      }
    }
    rows.push(row);
  }
  return rows;
}

function truncateText(text: string, width: number): string {
  if (stringWidth(text) <= width) return text;
  return wrapText(text, Math.max(1, width - 1), "")[0] + "…";
}

function eventStyle(event: TimelineEvent): { color: string; textColor: string; prefix: string } {
  if (event.tone) {
    return toneStyle(event.tone, event.kind);
  }

  switch (event.kind) {
    case "user":
      return { color: colors.accent, textColor: colors.textBright, prefix: "You" };
    case "steer":
      return { color: colors.keyword, textColor: colors.textBright, prefix: "◆ Steer" };
    case "assistant":
      return { color: colors.primary, textColor: colors.text, prefix: `${icons.arrowRight}` };
    case "system":
      return { color: colors.textDim, textColor: colors.textDim, prefix: "sys" };
    case "thinking":
      return { color: colors.keyword, textColor: colors.text, prefix: "..." };
    case "log":
      return { color: colors.info, textColor: colors.text, prefix: "$" };
    case "notice":
      return { color: colors.warning, textColor: colors.text, prefix: icons.warning };
    case "confirmation":
      return { color: colors.success, textColor: colors.textBright, prefix: icons.check };
    case "question":
      return { color: colors.accent, textColor: colors.textBright, prefix: "?" };
  }
}

function toneStyle(tone: TimelineEventTone, kind: TimelineEventKind) {
  const prefix = kind === "log" ? "$" : kind === "question" ? "?" : kind === "confirmation" ? icons.check : "i";
  switch (tone) {
    case "success":
      return { color: colors.success, textColor: colors.textBright, prefix: icons.check };
    case "warning":
      return { color: colors.warning, textColor: colors.text, prefix: icons.warning };
    case "error":
      return { color: colors.error, textColor: colors.textBright, prefix: icons.cross };
    case "muted":
      return { color: colors.textDim, textColor: colors.textDim, prefix };
    case "info":
      return { color: colors.info, textColor: colors.text, prefix };
  }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function maskValue(value: string): string {
  if (value.length === 0) return "";
  return "•".repeat(Math.min(12, Math.max(4, value.length)));
}
