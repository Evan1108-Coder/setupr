import { Lexer, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import { presentGrapheme } from "./textCells.js";
import { createTerminalControlInputStripper } from "./terminalInput.js";
import { colors } from "./theme.js";

export interface StyledSpan {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  color?: string;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const clean = (text: string) => createTerminalControlInputStripper().strip(text).replace(/\r\n?/g, "\n").replace(/\t/g, "    ");

function decoded(text: string) {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#39|#x[\da-f]+|#\d+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const value = entity.slice(2, -1);
    const code = value[0]?.toLowerCase() === "x" ? parseInt(value.slice(1), 16) : Number(value);
    return code >= 32 && code <= 0x10ffff && !(code >= 127 && code <= 159) && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

function inline(tokens: Token[], style: Omit<StyledSpan, "text"> = {}): StyledSpan[] {
  return tokens.flatMap((token): StyledSpan[] => {
    switch (token.type) {
      case "strong": return inline((token as Tokens.Strong).tokens, { ...style, bold: true });
      case "em": return inline((token as Tokens.Em).tokens, { ...style, italic: true });
      case "del": return inline((token as Tokens.Del).tokens, { ...style, strikethrough: true });
      case "codespan": return [{ ...style, color: colors.accent, text: decoded((token as Tokens.Codespan).text) }];
      case "link": {
        const link = token as Tokens.Link;
        const label = inline(link.tokens, { ...style, underline: true, color: colors.info });
        const safeUrl = /^(https?:\/\/|mailto:)/i.test(link.href) ? clean(link.href) : "";
        return safeUrl && label.map(s => s.text).join("") !== safeUrl ? [...label, { ...style, text: ` (${safeUrl})` }] : label;
      }
      case "image": return [{ ...style, text: `[Image: ${decoded((token as Tokens.Image).text)}]` }];
      case "br": return [{ ...style, text: "\n" }];
      default: {
        if ("tokens" in token && token.tokens) return inline(token.tokens as Token[], style);
        return [{ ...style, text: decoded("text" in token ? String(token.text) : token.raw) }];
      }
    }
  });
}

// Row production, not terminal escape generation: Ink owns styling and width.
export function markdownRows(text: string, width: number): StyledSpan[][] {
  const rows: StyledSpan[][] = [];
  const emit = (spans: StyledSpan[], indent = "", code = false) => rows.push(...wrapStyled(spans, width, indent, !code));
  const blocks = (tokens: Token[], prefix = "") => {
    for (const token of tokens) {
      switch (token.type) {
        case "space": if (rows.length && rows.at(-1)?.length) rows.push([]); break;
        case "heading": emit([{ text: prefix }, ...inline((token as Tokens.Heading).tokens, { bold: true, color: colors.heading })], prefix); break;
        case "paragraph": case "text": {
          const body = "tokens" in token && token.tokens ? inline(token.tokens as Token[]) : [{ text: decoded(String("text" in token ? token.text : token.raw)) }];
          emit([{ text: prefix }, ...body], prefix);
          break;
        }
        case "code": {
          const code = token as Tokens.Code;
          emit([{ text: prefix + (code.lang ? `[${code.lang}]` : "[code]"), color: colors.textDim }]);
          for (const line of code.text.split("\n")) emit([{ text: prefix + "  " + line, color: colors.accent }], prefix + "  ", true);
          break;
        }
        case "blockquote": blocks((token as Tokens.Blockquote).tokens, prefix + "> "); break;
        case "list": {
          const list = token as Tokens.List;
          list.items.forEach((item, index) => {
            const marker = item.task ? (item.checked ? "[x] " : "[ ] ") : list.ordered ? `${Number(list.start) + index}. ` : "- ";
            const nested = item.tokens.filter(t => t.type === "list");
            const body = item.tokens.filter(t => t.type !== "list");
            body.forEach((part, partIndex) => {
              const content = "tokens" in part && part.tokens ? inline(part.tokens as Token[]) : [{ text: decoded(String("text" in part ? part.text : part.raw)) }];
              emit([{ text: prefix + (partIndex ? " ".repeat(marker.length) : marker), color: colors.primary }, ...content], prefix + " ".repeat(marker.length));
            });
            blocks(nested, prefix + "  ");
          });
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          // Labeled records remain readable on narrow terminals without truncating cells.
          table.rows.forEach((record, index) => {
            if (index) rows.push([]);
            record.forEach((cell, column) => emit([{ text: prefix }, ...inline(table.header[column].tokens, { bold: true }), { text: ": " }, ...inline(cell.tokens)], prefix + "  "));
          });
          break;
        }
        case "hr": emit([{ text: "─".repeat(Math.min(width, 30)), color: colors.textDim }]); break;
        case "def": break;
        default: emit([{ text: prefix + token.raw }], prefix);
      }
    }
  };
  blocks(Lexer.lex(clean(text), { gfm: true, breaks: true }));
  while (rows.length && rows.at(-1)?.length === 0) rows.pop();
  return rows;
}

export function wrapStyled(spans: StyledSpan[], width: number, continuation = "", wordWrap = true): StyledSpan[][] {
  width = Math.max(1, Math.floor(width));
  continuation = continuation.slice(0, Math.max(0, Math.min(8, width - 1)));
  const rows: StyledSpan[][] = [];
  let line: StyledSpan[] = [];
  let cells = 0;
  const flush = (parts = line) => { rows.push(parts); line = []; cells = 0; };
  const indent = () => { line = continuation ? [{ text: continuation }] : []; cells = stringWidth(continuation); };
  for (const span of spans) {
    for (const { segment } of segmenter.segment(clean(span.text))) {
      if (segment === "\n") { flush(); indent(); continue; }
      for (const { segment: raw } of segmenter.segment(presentGrapheme(segment))) {
        const piece = stringWidth(raw) > width - stringWidth(continuation) ? "?" : raw;
        const size = stringWidth(piece);
        if (cells + size > width) {
          let split = -1;
          if (wordWrap) for (let i = line.length - 1; i > 0; i--) if (/^\s+$/.test(line[i].text) && stringWidth(line.slice(0, i).map(s => s.text).join("")) > stringWidth(continuation)) { split = i; break; }
          if (split > 0) {
            const rest = line.slice(split + 1);
            flush(line.slice(0, split));
            indent(); line.push(...rest); cells += stringWidth(rest.map(s => s.text).join(""));
          } else { flush(); indent(); }
          if (wordWrap && /^\s+$/.test(piece) && cells === stringWidth(continuation)) continue;
        }
        line.push({ ...span, text: piece }); cells += size;
      }
    }
  }
  if (line.length || rows.length === 0) flush();
  return rows.map(parts => {
    const merged: StyledSpan[] = [];
    for (const part of parts) {
      const previous = merged.at(-1);
      if (previous && previous.bold === part.bold && previous.italic === part.italic && previous.color === part.color && previous.underline === part.underline && previous.strikethrough === part.strikethrough) previous.text += part.text;
      else merged.push({ ...part });
    }
    return merged;
  });
}
