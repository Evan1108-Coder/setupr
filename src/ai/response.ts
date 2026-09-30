/** Remove provider reasoning envelopes, but keep literal tags in Markdown code. */
export function stripHiddenReasoning(text: string): string {
  let depth = 0;
  let fence: { marker: string; length: number } | undefined;
  const output: string[] = [];

  for (const line of text.split("\n")) {
    if (fence) {
      output.push(line);
      const close = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) fence = undefined;
      continue;
    }
    const open = depth === 0 ? /^ {0,3}(`{3,}|~{3,})/.exec(line) : null;
    if (open) {
      fence = { marker: open[1][0], length: open[1].length };
      output.push(line);
      continue;
    }

    let visible = "";
    let cursor = 0;
    const markers = /<\/?(?:think|thinking)\s*>|`+/gi;
    let match: RegExpExecArray | null;
    while ((match = markers.exec(line))) {
      if (depth === 0) visible += line.slice(cursor, match.index);
      const marker = match[0];
      let end = markers.lastIndex;
      if (marker.startsWith("`")) {
        if (depth === 0) {
          const close = line.indexOf(marker, end);
          if (close !== -1) end = close + marker.length;
          visible += line.slice(match.index, end);
        }
      } else if (marker.startsWith("</")) {
        depth = Math.max(0, depth - 1);
      } else {
        depth++;
      }
      cursor = end;
      markers.lastIndex = end;
    }
    if (depth === 0) visible += line.slice(cursor);
    output.push(visible);
  }
  return output.join("\n").trim();
}

export function extractVisibleAnswer(
  text: string | null | undefined,
  model = "AI provider",
  finishReason?: string | null
): string {
  const content = stripHiddenReasoning(text ?? "");
  if (content) return content;

  const truncated = /^(length|max_tokens|max_output_tokens)$/i.test(finishReason ?? "");
  const explanation = truncated
    ? "the output token limit was reached before an answer was produced. Increase maxTokens or switch to a non-reasoning model."
    : "the provider returned an empty or reasoning-only response with no answer. Retry or switch to another model.";
  throw new Error(`Invalid response from ${model}: ${explanation}`);
}
