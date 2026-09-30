import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, type DOMElement } from "ink";
import stringWidth from "string-width";
import { presentGrapheme } from "../textCells.js";
import { colors } from "../theme.js";
import { createTerminalControlInputStripper, useRawTerminalInput, type TerminalInputKey } from "../terminalInput.js";
import type { FocusBounds } from "../hooks/useFocusNavigation.js";
import { terminalBounds } from "../terminalBounds.js";

interface BoundedTextInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, meta?: { steer?: boolean }) => void;
  focus: boolean;
  placeholder?: string;
  mask?: string;
  width?: number;
  maxLines?: number;
  scrollBounds?: FocusBounds;
}

export function BoundedTextInput({
  value,
  onChange,
  onSubmit,
  focus,
  placeholder = "",
  mask,
  width,
  maxLines = 4,
  scrollBounds,
}: BoundedTextInputProps) {
  const [cursor, setCursor] = useState(value.length);
  const element = useRef<DOMElement>(null);
  const [submissionRevision, setSubmissionRevision] = useState(0);
  const [scroll, setScroll] = useState<{ lines: WrappedLine[]; height: number; line: number } | null>(null);
  const controlStripper = useMemo(() => createTerminalControlInputStripper(), []);
  const wrapWidth = Math.max(1, Math.floor(width || 80));

  // The controlled `value` prop only updates after a React render. A burst of
  // keystrokes that arrives before the next render would otherwise all read the
  // same stale `value`/`cursor` from this closure, dropping or scrambling
  // characters. We keep ref copies that are mutated synchronously on every edit
  // so consecutive keystrokes compose against the live text, not a stale snapshot.
  const valueRef = useRef(value);
  const cursorRef = useRef(cursor);
  // Values we have emitted via onChange but not yet seen reflected back through
  // the `value` prop. Used to tell our own (possibly batched/stale) prop echoes
  // apart from a genuine parent-driven change such as a reset after submit.
  const pendingEmitsRef = useRef<Set<string>>(new Set());

  // Reconcile the controlled prop with our live ref state. A prop value we
  // recently emitted is just an echo of our own edit (React may coalesce a burst
  // into a single render, skipping intermediates), so we keep the live refs. Any
  // other value is a genuine external change (e.g. the parent clearing the field
  // after submit) and is adopted.
  useEffect(() => {
    // Already in sync with our live edit state — nothing to adopt.
    if (value === valueRef.current) {
      pendingEmitsRef.current.clear();
      return;
    }
    // A lagging echo of a value we emitted (React may render intermediate burst
    // states). Drop just that entry; never rewind the live refs backward.
    if (pendingEmitsRef.current.has(value)) {
      pendingEmitsRef.current.delete(value);
      return;
    }
    // Genuine external change (e.g. parent reset after submit).
    pendingEmitsRef.current.clear();
    valueRef.current = value;
    cursorRef.current = graphemeBoundary(value, Math.min(cursorRef.current, value.length));
    setCursor(cursorRef.current);
  }, [value, submissionRevision]);

  const { lines, cursorLine } = useMemo(
    () => wrapInput(value, cursor, focus, mask, placeholder, wrapWidth),
    [value, cursor, focus, mask, placeholder, wrapWidth]
  );
  const visibleHeight = Math.min(Math.max(1, Math.floor(maxLines)), Math.max(1, lines.length));
  const maxScroll = Math.max(0, lines.length - visibleHeight);
  // Manual scrolling persists until text, caret, focus, or geometry changes.
  // Deriving this avoids a stale top-of-input frame before an effect catches up.
  const scrollLine = scroll?.lines === lines && scroll.height === visibleHeight
    ? clamp(scroll.line, 0, maxScroll)
    : clamp(focus ? cursorLine - visibleHeight + 1 : scroll?.line || 0, 0, maxScroll);
  const scrollBy = (delta: number) => setScroll((current) => ({
    lines, height: visibleHeight,
    line: clamp((current?.lines === lines ? current.line : scrollLine) + delta, 0, maxScroll),
  }));

  // Apply a text edit synchronously against the live ref state, then notify the
  // parent and schedule the visible caret update.
  const commit = (nextValue: string, nextCursor: number) => {
    valueRef.current = nextValue;
    cursorRef.current = nextCursor <= 0 ? 0 : nextGraphemeIndex(nextValue, clamp(nextCursor - 1, 0, nextValue.length));
    pendingEmitsRef.current.add(nextValue);
    setScroll(null);
    setCursor(cursorRef.current);
    onChange(nextValue);
  };

  const moveCursor = (nextCursor: number) => {
    cursorRef.current = graphemeBoundary(valueRef.current, clamp(nextCursor, 0, valueRef.current.length));
    setCursor(cursorRef.current);
    setScroll(null);
  };

  const submit = (text: string, steer = false) => {
    onSubmit(text, { steer });
    // Coalesced typing and submit may leave the parent's value unchanged (an
    // empty chat draft cleared in the same batch). Reconcile its response even
    // when the value dependency alone would not run the effect again.
    setSubmissionRevision((revision) => revision + 1);
  };

  useRawTerminalInput((input) => {
    const chunk = controlStripper.read(input);
    const liveBounds = terminalBounds(element.current);
    const inputBounds = liveBounds?.width && liveBounds.height ? liveBounds : scrollBounds;
    for (const mouse of chunk.mouse) {
      if (chunk.paste || chunk.text) continue;
      if (mouse.action === "press" && (mouse.code & 3) === 0) {
        if (inputBounds && pointInBounds(mouse.x, mouse.y, inputBounds)) {
          const line = clamp(mouse.y - inputBounds.y + scrollLine, 0, Math.max(0, lines.length - 1));
          const column = clamp(mouse.x - inputBounds.x, 0, wrapWidth);
          moveCursor(cursorForWrappedPosition(lines[line], column));
        }
      } else if (focus && mouse.action === "scroll" && (mouse.code & 3) < 2) {
        if (!inputBounds || pointInBounds(mouse.x, mouse.y, inputBounds)) {
          scrollBy((mouse.code & 1) === 0 ? -1 : 1);
        }
      }
    }
    if (!focus) return;

    // Preserve the existing unbracketed multiline-paste policy. Only a single
    // trailing Enter submits; bracketed newlines are always literal text events.
    const enters = chunk.events.filter((event) => event.type === "key" && event.key === "enter");
    const trailingEnter = enters.length === 1 && chunk.events[chunk.events.length - 1] === enters[0];
    let liveValue = valueRef.current;
    let liveCursor = clamp(cursorRef.current, 0, liveValue.length);
    let edited = false;
    let moved = false;
    // A held key may contribute hundreds of events in one read. Compose them
    // locally and publish once, flushing before actions that observe the draft.
    const edit = (nextValue: string, nextCursor: number) => {
      liveValue = nextValue;
      liveCursor = nextCursor <= 0 ? 0 : nextGraphemeIndex(nextValue, clamp(nextCursor - 1, 0, nextValue.length));
      edited = true;
    };
    const move = (nextCursor: number) => {
      liveCursor = graphemeBoundary(liveValue, clamp(nextCursor, 0, liveValue.length));
      moved = true;
    };
    const flush = () => {
      if (edited) commit(liveValue, liveCursor);
      else if (moved) moveCursor(liveCursor);
      edited = moved = false;
    };
    for (const event of chunk.events) {
      if (event.type === "text") {
        if (!event.paste && event.text === "\t") continue;
        edit(liveValue.slice(0, liveCursor) + event.text + liveValue.slice(liveCursor), liveCursor + event.text.length);
      } else if (event.key === "steer" || (event.key === "enter" && trailingEnter)) {
        flush();
        submit(liveValue, event.key === "steer");
        liveValue = valueRef.current;
        liveCursor = cursorRef.current;
      } else if (event.key === "enter") {
        edit(liveValue.slice(0, liveCursor) + "\n" + liveValue.slice(liveCursor), liveCursor + 1);
      } else if (event.key === "up" || event.key === "down") {
        flush();
        scrollBy(event.key === "up" ? -1 : 1);
      } else {
        applyShortcut(event.key, liveValue, liveCursor, edit, move);
      }
    }
    flush();
  });

  const visibleLines = lines.slice(scrollLine, scrollLine + visibleHeight);
  const placeholderColor = value.length === 0 ? colors.textDim : colors.text;

  return (
    <Box ref={element} flexDirection="column" height={visibleHeight} overflowY="hidden" width={wrapWidth} minWidth={0} flexShrink={1}>
      {visibleLines.map((line, index) => (
        <Text key={`${scrollLine}-${index}`} color={placeholderColor} wrap="truncate">
          {line.text || " "}
        </Text>
      ))}
    </Box>
  );
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface WrappedLine {
  text: string;
  stops: Array<{ column: number; index: number }>;
}

function wrapInput(value: string, cursor: number, focus: boolean, mask: string | undefined, placeholder: string, width: number) {
  const lines: WrappedLine[] = [{ text: "", stops: [{ column: 0, index: 0 }] }];
  let column = 0;
  let cursorLine = 0;
  const append = (text: string, start: number, end: number, caret = false) => {
    if (text === "\n") {
      lines.push({ text: "", stops: [{ column: 0, index: end }] });
      column = 0;
      return;
    }
    if (text === "\t") text = " ".repeat(Math.min(width, 4 - column % 4));
    let cells = stringWidth(text);
    if (cells > width) { text = "…"; cells = 1; }
    if (column + cells > width) {
      lines.push({ text: "", stops: [{ column: 0, index: start }] });
      column = 0;
    }
    if (caret) cursorLine = lines.length - 1;
    const line = lines[lines.length - 1];
    line.stops.push({ column, index: start });
    line.text += text;
    column += cells;
    line.stops.push({ column, index: end });
  };
  const safeCursor = graphemeBoundary(value, clamp(cursor, 0, value.length));
  for (const { segment, index } of segmenter.segment(value || placeholder)) {
    if (focus && index === safeCursor) append("▌", safeCursor, safeCursor, true);
    const source = value ? (segment === "\n" ? segment : mask || segment) : segment;
    const presentation = presentGrapheme(source);
    const start = value ? index : 0;
    const end = value ? index + segment.length : 0;
    // Escaped presentations may span rows, but every cell still maps to the
    // original grapheme. Editing and mouse placement never split that value.
    const pieces = [...segmenter.segment(presentation)];
    for (let piece = 0; piece < pieces.length; piece++) {
      append(pieces[piece].segment, start, piece === pieces.length - 1 ? end : start);
    }
  }
  if (focus && safeCursor === value.length && (value || !placeholder)) append("▌", safeCursor, safeCursor, true);
  return { lines, cursorLine };
}

function cursorForWrappedPosition(line: WrappedLine, column: number): number {
  return line.stops.reduce((best, stop) => stop.column <= column ? stop : best, line.stops[0]).index;
}

function graphemeBoundary(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  for (const { segment, index } of segmenter.segment(value)) if (index + segment.length > cursor) return index;
  return 0;
}

function previousGraphemeIndex(value: string, cursor: number): number {
  return graphemeBoundary(value, Math.max(0, cursor - 1));
}

function nextGraphemeIndex(value: string, cursor: number): number {
  for (const { segment, index } of segmenter.segment(value)) if (index + segment.length > cursor) return index + segment.length;
  return value.length;
}

function applyShortcut(
  shortcut: TerminalInputKey,
  value: string,
  cursor: number,
  commit: (value: string, cursor: number) => void,
  moveCursor: (cursor: number) => void
): void {
  if (shortcut === "start") {
    moveCursor(0);
    return;
  }
  if (shortcut === "end") {
    moveCursor(value.length);
    return;
  }
  if (shortcut === "left") {
    moveCursor(previousGraphemeIndex(value, cursor));
    return;
  }
  if (shortcut === "right") {
    moveCursor(nextGraphemeIndex(value, cursor));
    return;
  }
  if (shortcut === "delete-backward") {
    if (cursor > 0) {
      const previous = previousGraphemeIndex(value, cursor);
      commit(value.slice(0, previous) + value.slice(cursor), previous);
    }
    return;
  }
  if (shortcut === "clear-before") {
    commit(value.slice(cursor), 0);
    return;
  }
  if (shortcut === "clear-after") {
    commit(value.slice(0, cursor), cursor);
    return;
  }
  if (shortcut === "delete-forward") {
    if (cursor < value.length) commit(value.slice(0, cursor) + value.slice(nextGraphemeIndex(value, cursor)), cursor);
    return;
  }
  if (shortcut === "word-left") {
    moveCursor(previousWordIndex(value, cursor));
    return;
  }
  if (shortcut === "word-right") {
    moveCursor(nextWordIndex(value, cursor));
    return;
  }
  if (shortcut === "delete-word-before") {
    const nextCursor = previousWordIndex(value, cursor);
    commit(value.slice(0, nextCursor) + value.slice(cursor), nextCursor);
    return;
  }
  if (shortcut === "delete-word-after") {
    const nextCursor = nextWordIndex(value, cursor);
    commit(value.slice(0, cursor) + value.slice(nextCursor), cursor);
  }
}

function previousWordIndex(value: string, cursor: number): number {
  const graphemes = [...segmenter.segment(value.slice(0, cursor))];
  let index = graphemes.length;
  while (index > 0 && /^\s/u.test(graphemes[index - 1].segment)) index--;
  while (index > 0 && !/^\s/u.test(graphemes[index - 1].segment)) index--;
  return graphemes[index]?.index ?? cursor;
}

function nextWordIndex(value: string, cursor: number): number {
  let inWord = false;
  for (const { segment, index } of segmenter.segment(value.slice(cursor))) {
    const whitespace = /^\s/u.test(segment);
    if (inWord && whitespace) return cursor + index;
    if (!whitespace) inWord = true;
  }
  return value.length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pointInBounds(x: number, y: number, bounds: FocusBounds): boolean {
  return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}
