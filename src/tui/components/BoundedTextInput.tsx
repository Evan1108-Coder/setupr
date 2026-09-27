import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import isFullwidthCodePoint from "is-fullwidth-code-point";
import { colors } from "../theme.js";
import { createTerminalControlInputStripper, useTerminalInput } from "../terminalInput.js";
import type { FocusBounds } from "../hooks/useFocusNavigation.js";

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

  useTerminalInput((_input, key, input) => {
    const chunk = controlStripper.read(input);
    for (const mouse of chunk.mouse) {
      if (chunk.paste || chunk.text) continue;
      if (mouse.action === "press" && (mouse.code & 3) === 0) {
        if (scrollBounds && pointInBounds(mouse.x, mouse.y, scrollBounds)) {
          const line = clamp(mouse.y - scrollBounds.y + scrollLine, 0, Math.max(0, lines.length - 1));
          const column = clamp(mouse.x - scrollBounds.x, 0, wrapWidth);
          moveCursor(cursorForWrappedPosition(lines[line], column));
        }
      } else if (focus && mouse.action === "scroll" && (mouse.code & 3) < 2) {
        if (!scrollBounds || pointInBounds(mouse.x, mouse.y, scrollBounds)) {
          scrollBy((mouse.code & 1) === 0 ? -1 : 1);
        }
      }
    }
    if (!focus) return;

    const liveValue = valueRef.current;
    const liveCursor = clamp(cursorRef.current, 0, liveValue.length);

    const shortcut = !chunk.paste && !chunk.continuation && shortcutFromInput(input, key);
    if (shortcut) {
      applyShortcut(shortcut, liveValue, liveCursor, commit, moveCursor);
      return;
    }

    const cleanInput = chunk.text;
    if (chunk.paste || chunk.continuation) {
      if (cleanInput) commit(liveValue.slice(0, liveCursor) + cleanInput + liveValue.slice(liveCursor), liveCursor + cleanInput.length);
      return;
    }
    if (input === "\x1b[13;5u") {
      submit(liveValue, true);
      return;
    }
    // stdin read boundaries are not keystroke boundaries. A single-line chunk
    // ending in Enter is typing + submit; bracketed paste was handled above.
    // Keep unbracketed multiline chunks as drafts rather than guessing that a
    // pasted line break was intended to submit an action.
    if (/[\r\n]$/.test(input) && /^[^\n]*\n$/.test(cleanInput)) {
      const typed = cleanInput.slice(0, -1);
      const nextValue = liveValue.slice(0, liveCursor) + typed + liveValue.slice(liveCursor);
      if (typed) commit(nextValue, liveCursor + typed.length);
      submit(nextValue, Boolean(key.ctrl));
      return;
    }

    // Preserve the existing backward-delete behavior for both Backspace and
    // Fn+Delete. Ctrl+D is the explicit forward-delete shortcut.
    if (key.backspace || key.delete || input === "\x7f") {
      if (liveCursor === 0) return;
      const previous = previousGraphemeIndex(liveValue, liveCursor);
      commit(liveValue.slice(0, previous) + liveValue.slice(liveCursor), previous);
      return;
    }

    if (key.leftArrow) {
      moveCursor(previousGraphemeIndex(liveValue, liveCursor));
      return;
    }

    if (key.rightArrow) {
      moveCursor(nextGraphemeIndex(liveValue, liveCursor));
      return;
    }

    if (key.upArrow) {
      scrollBy(-1);
      return;
    }

    if (key.downArrow) {
      scrollBy(1);
      return;
    }

    if (key.tab || key.escape || key.ctrl || key.meta) {
      return;
    }

    if (cleanInput) {
      commit(liveValue.slice(0, liveCursor) + cleanInput + liveValue.slice(liveCursor), liveCursor + cleanInput.length);
    }
  });

  const visibleLines = lines.slice(scrollLine, scrollLine + visibleHeight);
  const placeholderColor = value.length === 0 ? colors.textDim : colors.text;

  return (
    <Box flexDirection="column" height={visibleHeight} overflowY="hidden" width={wrapWidth} minWidth={0} flexShrink={1}>
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

function presentGrapheme(value: string): string {
  if (value === "\n" || value === "\t") return value;
  const normalized = value.normalize("NFC");
  // Ink 5 Output allocates a cell per code point, or two for supplementary /
  // full-width points. NFC fixes composable accents; escapes preserve the exact
  // identity of clusters its rasterizer cannot safely draw, without rewriting
  // the controlled value or relying on a runtime patch to Ink internals.
  const inkCells = [...normalized].reduce((cells, point) => cells + (point.length > 1 || isFullwidthCodePoint(point.codePointAt(0)!) ? 2 : 1), 0);
  if (inkCells === stringWidth(normalized)) return normalized;
  return [...value].map((point) => `\\u{${point.codePointAt(0)!.toString(16)}}`).join("");
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

type InputShortcut =
  | "start"
  | "end"
  | "clear-before"
  | "clear-after"
  | "delete-word-before"
  | "delete-word-after"
  | "delete-forward"
  | "word-left"
  | "word-right";

function shortcutFromInput(input: string, key: { ctrl?: boolean; meta?: boolean; delete?: boolean }): InputShortcut | null {
  if (key.ctrl) {
    if (input === "a" || input === "\x01") return "start";
    if (input === "e" || input === "\x05") return "end";
    if (input === "u" || input === "\x15") return "clear-before";
    if (input === "k" || input === "\x0b") return "clear-after";
    if (input === "w" || input === "\x17") return "delete-word-before";
    if (input === "d" || input === "\x04") return "delete-forward";
  }
  if (["\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"].includes(input)) return "start";
  if (["\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"].includes(input)) return "end";
  if (input === "\x17") return "delete-word-before";
  if (input === "\x1bb" || input === "\x1b[1;3D" || input === "\x1b[1;5D" || input === "\x1b[1;9D" || input === "\x1b[5D") return "word-left";
  if (input === "\x1bf" || input === "\x1b[1;3C" || input === "\x1b[1;5C" || input === "\x1b[1;9C" || input === "\x1b[5C") return "word-right";
  if (input === "\x1b\x7f" || input === "\x1b\b" || input === "\x1b[3;3~" || input === "\x1b[3;5~") return "delete-word-before";
  if (input === "\x1bd" || input === "\x1b[3;2~" || input === "\x1b[3;6~") return "delete-word-after";
  // Note: a bare delete key (\x7f / \x1b[3~) is intentionally NOT a forward delete;
  // it is handled as a backward Backspace in the main handler. Only Ctrl+D
  // (matched above) performs a forward delete.
  return null;
}

function applyShortcut(
  shortcut: InputShortcut,
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
  let index = Math.max(0, cursor);
  while (index > 0 && /\s/.test(value[index - 1])) index--;
  while (index > 0 && !/\s/.test(value[index - 1])) index--;
  return index;
}

function nextWordIndex(value: string, cursor: number): number {
  let index = Math.min(value.length, cursor);
  while (index < value.length && /\s/.test(value[index])) index++;
  while (index < value.length && !/\s/.test(value[index])) index++;
  return index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pointInBounds(x: number, y: number, bounds: FocusBounds): boolean {
  return x >= bounds.x && x < bounds.x + bounds.width && y >= bounds.y && y < bounds.y + bounds.height;
}
