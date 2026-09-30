import type { WriteStream } from "node:tty";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const RESET = "\x1b[0m";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function fitLine(line: string, columns: number): string {
  if (stringWidth(line) <= columns) return line;

  // A resize can arrive before React commits the narrower layout. Clip that
  // stale row as plain text rather than splitting an escape or a grapheme.
  let clipped = "";
  let width = 0;
  for (const { segment } of graphemes.segment(stripAnsi(line))) {
    const cells = stringWidth(segment);
    if (width + cells > columns) break;
    clipped += segment;
    width += cells;
  }
  return clipped;
}

/** Use with Ink's debug (complete-frame) output, never as a global stdout patch. */
export function createFullscreenOutput(target: WriteStream): {
  stdout: WriteStream;
  debug: boolean;
  dispose: () => void;
} {
  if (!target.isTTY) return { stdout: target, debug: false, dispose: () => {} };

  let previous: string[] | undefined;
  let lastFrame: string | undefined;
  let dimensions = "";
  let disposed = false;

  function paint(frame: string, done?: (error?: Error | null) => void): boolean {
    lastFrame = frame;
    const rows = Math.max(1, target.rows || 24);
    const columns = Math.max(1, target.columns || 80);
    const nextDimensions = `${columns}x${rows}`;
    if (dimensions !== nextDimensions) previous = undefined;
    const lines = frame.split("\n");
    const next = Array.from({ length: rows }, (_, row) => fitLine(lines[row] ?? "", columns));
    let output = "";
    for (let row = 0; row < rows; row++) {
      const line = next[row];
      if (previous?.[row] === line) continue;
      output += `\x1b[${row + 1};1H${RESET}${line}${RESET}`;
      const width = stringWidth(line);
      // CUP cancels pending autowrap. Never erase at the last column after a
      // full-width row: that would erase its final cell on real terminals.
      if (width < columns) output += `\x1b[${row + 1};${width + 1}H\x1b[K`;
    }

    if (!output) {
      // Queue a zero-byte write only when needed to retain Writable callback
      // ordering behind an earlier frame that is still draining.
      if (done) return target.write("", done);
      return !target.writableNeedDrain;
    }

    // No LF at the bottom margin, no screen/scrollback erase, and no interval
    // where the entire viewport is blank, even without synchronized output.
    const accepted = target.write(`${SYNC_START}${output}\x1b[1;1H${SYNC_END}`, done);
    previous = next;
    dimensions = nextDimensions;
    return accepted;
  }

  const resized = () => {
    // Reflow may have moved even unchanged rows. Repaint before Ink's resize
    // listener, including when the next React commit has identical text.
    previous = undefined;
    if (lastFrame !== undefined) paint(lastFrame);
  };
  target.on("resize", resized);

  const write: WriteStream["write"] = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void
  ): boolean {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (disposed || text === SHOW_CURSOR || text === HIDE_CURSOR) {
      return target.write(chunk, encodingOrCallback as BufferEncoding, callback);
    }
    return paint(text, typeof encodingOrCallback === "function" ? encodingOrCallback : callback);
  };

  const stdout = new Proxy(target, {
    get(stream, key) {
      if (key === "write") return write;
      const value: unknown = Reflect.get(stream, key, stream);
      return typeof value === "function" ? value.bind(stream) : value;
    },
  });

  return {
    stdout,
    debug: true,
    dispose() {
      if (disposed) return;
      disposed = true;
      target.off("resize", resized);
      previous = undefined;
      lastFrame = undefined;
      target.write(`${SYNC_END}${RESET}${SHOW_CURSOR}`);
    },
  };
}
