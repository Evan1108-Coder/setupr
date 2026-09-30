import stringWidth from "string-width";
import isFullwidthCodePoint from "is-fullwidth-code-point";

// Ink 5's rasterizer counts some Unicode clusters differently from terminals.
// Keep their exact identity visible without allowing them to displace borders.
export function presentGrapheme(value: string): string {
  if (value === "\n" || value === "\t") return value;
  const normalized = value.normalize("NFC");
  const inkCells = [...normalized].reduce((cells, point) => cells + (point.length > 1 || isFullwidthCodePoint(point.codePointAt(0)!) ? 2 : 1), 0);
  if (inkCells === stringWidth(normalized)) return normalized;
  return [...value].map((point) => `\\u{${point.codePointAt(0)!.toString(16)}}`).join("");
}
