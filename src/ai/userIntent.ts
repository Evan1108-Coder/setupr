import { sanitizeForAI } from "./directorContext.js";
import { interpretEnvBatch } from "./setupFlow.js";

export type UserIntentKind =
  | "answer"
  | "cancel"
  | "env"
  | "model"
  | "plan"
  | "question"
  | "retry"
  | "status"
  | "unknown";

export type UserIntentTarget =
  | "build"
  | "database"
  | "dependencies"
  | "docker"
  | "environment"
  | "model"
  | "package-manager"
  | "port"
  | "setup"
  | "test"
  | "verification";

export interface ParsedUserIntent {
  raw: string;
  sanitizedRaw: string;
  normalizedText: string;
  kind: UserIntentKind;
  action?: "answer" | "cancel" | "change" | "continue" | "fill" | "retry" | "skip" | "status";
  target?: UserIntentTarget;
  value?: string;
  confidence: "high" | "medium" | "low";
  reason: string;
  compact: string;
  envKeys?: string[];
}

const TYPO_NORMALIZATIONS: Array<[RegExp, string]> = [
  [/\bsk+p+\b|\bskp\b|\bskipp?\b/gi, "skip"],
  [/\bdatabse\b|\bdb\b|\bpostgres?s?\b|\bpostgress\b/gi, "database"],
  [/\bdepndenc(?:y|ies)\b|\bdeps?\b/gi, "dependencies"],
  [/\benviorn?ment\b|\benv\b/gi, "environment"],
  [/\bverif(?:y|cation)\b|\bche?k\b/gi, "verification"],
  [/\bdoker\b|\bdockr\b/gi, "docker"],
  [/\bcnacel\b|\bcancle\b/gi, "cancel"],
  [/\bconti?nue\b|\bproce?ed\b/gi, "continue"],
];

export function parseUserIntent(input: string): ParsedUserIntent {
  const raw = input.trim();
  const sanitizedRaw = sanitizeForAI(raw);
  const normalizedText = normalizeUserText(raw);
  const informationalQuestion = /^(?:what|which|why|how|where|when|is|are|does)\b|^do (?:you|i|we|they)\b/i.test(normalizedText);
  const env = interpretEnvBatch(raw);
  const envKeys = env.vars.map((item) => item.key);
  if (envKeys.length > 0) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "env",
      action: "fill",
      confidence: "high",
      reason: "Detected KEY=value environment assignments.",
      envKeys,
    });
  }

  if (informationalQuestion) {
    return buildIntent({
      raw, sanitizedRaw, normalizedText,
      kind: "question", confidence: "high",
      reason: "Detected an informational question; quoted constraints are not plan changes.",
    });
  }

  const modelMatch = normalizedText.match(/\b(?:use|switch|change|set).{0,24}\bmodel\b|\b(?:use|switch to|change to)\s+([A-Za-z0-9_.:/-]+)\b.*\bmodel\b|\b(gpt|claude|gemini|llama|minimax|kimi|moonshot)\b/i);
  if (modelMatch) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "model",
      action: "change",
      target: "model",
      value: extractLikelyValue(normalizedText),
      confidence: "high",
      reason: "Detected model selection language.",
    });
  }

  const packageManager = normalizedText.match(/\b(?:use|prefer|switch to|change to)\s+(npm|pnpm|yarn|bun)\b/i)?.[1];
  if (packageManager) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "plan",
      action: "change",
      target: "package-manager",
      value: packageManager,
      confidence: "high",
      reason: "Detected package-manager steering.",
    });
  }

  const port = normalizedText.match(/\bport\s*[:=]?\s*(\d{2,5})\b|\buse\s+(\d{2,5})\b/i);
  if (port) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "plan",
      action: "change",
      target: "port",
      value: port[1] || port[2],
      confidence: "high",
      reason: "Detected port steering.",
    });
  }

  if (/\b(status|what are you doing|show plan|current plan|where are we)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "status",
      action: "status",
      confidence: "high",
      reason: "Detected status request.",
    });
  }

  if (/\b(retry|try again|rerun|run again)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "retry",
      action: "retry",
      confidence: "high",
      reason: "Detected retry request.",
    });
  }

  if (/\b(cancel|stop|abort|exit|no)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "cancel",
      action: "cancel",
      confidence: "high",
      reason: "Detected cancellation language.",
    });
  }

  if (/\b(yes|y|ok|okay|continue|confirm|proceed|looks good|run it)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "answer",
      action: "continue",
      confidence: "high",
      reason: "Detected confirmation language.",
    });
  }

  const skipTarget = detectSkipTarget(normalizedText);
  if (skipTarget) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "plan",
      action: "skip",
      target: skipTarget,
      confidence: "high",
      reason: `Detected request to skip ${skipTarget}.`,
    });
  }

  if (/\b(skip|avoid|without|do not|don't|dont|no)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "plan",
      action: "skip",
      confidence: "medium",
      reason: "Detected a skip/avoid instruction but the target is ambiguous.",
    });
  }

  if (/\?$|\b(what|why|how|explain|tell me|show me|can you|should i)\b/i.test(normalizedText)) {
    return buildIntent({
      raw,
      sanitizedRaw,
      normalizedText,
      kind: "question",
      confidence: "high",
      reason: "Detected a user question.",
    });
  }

  return buildIntent({
    raw,
    sanitizedRaw,
    normalizedText,
    kind: "unknown",
    confidence: raw.length > 0 ? "low" : "high",
    reason: raw.length > 0
      ? "No reliable local intent match; live AI should read the raw message if available."
      : "Empty input.",
  });
}

export function intentToSteeringText(intent: ParsedUserIntent): string {
  if (intent.kind !== "plan") return intent.raw;
  if (intent.target === "package-manager" && intent.value) return `use ${intent.value}`;
  if (intent.target === "port" && intent.value) return `use port ${intent.value}`;
  if (intent.action === "skip" && intent.target) return `skip ${intent.target}`;
  return intent.normalizedText || intent.raw;
}

export function compactUserIntent(intent: ParsedUserIntent): string {
  return intent.compact;
}

function normalizeUserText(input: string): string {
  let text = input.trim().replace(/\s+/g, " ");
  for (const [pattern, replacement] of TYPO_NORMALIZATIONS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function detectSkipTarget(text: string): UserIntentTarget | undefined {
  const skipSignal = /\b(skip|avoid|without|do not|don't|dont|no)\b/i;
  if (!skipSignal.test(text)) return undefined;
  if (/\b(database|migration|migrate|prisma|alembic|postgres|mysql|redis)\b/i.test(text)) return "database";
  if (/\b(docker|compose|container)\b/i.test(text)) return "docker";
  if (/\b(build|compile)\b/i.test(text)) return "build";
  if (/\b(test|tests)\b/i.test(text)) return "test";
  if (/\b(verify|verification|check)\b/i.test(text)) return "verification";
  if (/\b(dependencies|install|package|node_modules)\b/i.test(text)) return "dependencies";
  if (/\b(environment|\.env|env file)\b/i.test(text)) return "environment";
  if (/\b(setup|prepare|init)\b/i.test(text)) return "setup";
  return undefined;
}

function extractLikelyValue(text: string): string | undefined {
  const modelish = text.match(/\b(?:gpt|claude|gemini|llama|minimax|kimi|moonshot|openai\/)[A-Za-z0-9_.:/-]*/i)?.[0];
  return modelish;
}

function buildIntent(input: Omit<ParsedUserIntent, "compact">): ParsedUserIntent {
  const compact = [
    `raw_len=${input.raw.length}`,
    `kind=${input.kind}`,
    input.action ? `act=${input.action}` : "",
    input.target ? `target=${input.target}` : "",
    input.value ? `value=${sanitizeForAI(input.value)}` : "",
    `conf=${input.confidence}`,
    input.envKeys?.length ? `env=${input.envKeys.map(sanitizeForAI).join(",")}` : "",
  ].filter(Boolean).join(" ");

  return { ...input, compact };
}
