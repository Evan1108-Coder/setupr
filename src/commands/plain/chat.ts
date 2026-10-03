import chalk from "chalk";
import { createAppStore } from "../../state/store.js";
import { createProjectEngine, redactText } from "../../core/engine.js";
import { contextToDSL } from "../../ai/dsl.js";
import { handleDirectorInput } from "../../ai/director.js";
import { createSetuprError, printPlainError } from "../../errors/index.js";

interface ChatFlags {
  args?: string[];
  json?: boolean;
  provider?: string;
  model?: string;
}

export interface ChatAnswer {
  text: string;
  action: string;
  level?: string;
  cost?: number;
  failed?: boolean;
}

export async function cmdChat(first: string | undefined, cwd: string, flags: ChatFlags = {}): Promise<void> {
  const text = [first, ...(flags.args || [])].filter(Boolean).join(" ").trim();
  if (!text) {
    printPlainError(createSetuprError({
      code: "NON_INTERACTIVE_INPUT_REQUIRED",
      command: "chat",
      cwd,
      details: ["Usage: setupr chat <question or instruction>"],
      nextSteps: [
        "Ask about the project, for example: setupr chat how do I start this app?",
        "Use the dashboard TUI for continuous chat while setup is running.",
      ],
    }));
    return;
  }

  const answer = await askProjectChat(cwd, text, flags);
  if (answer.failed) process.exitCode = 1;
  if (flags.json) {
    console.log(JSON.stringify(answer, null, 2));
    return;
  }
  console.log(chalk.blue.bold("\n  Setupr Chat\n"));
  console.log(formatChatAnswer(answer.text));
  if (answer.level || answer.cost) {
    console.log(chalk.dim(`\n  ${answer.level || "pattern"}${answer.cost ? ` · approx cost $${answer.cost.toFixed(6)}` : ""}`));
  }
  console.log("");
}

export async function askProjectChat(cwd: string, text: string, flags: ChatFlags = {}): Promise<ChatAnswer> {
  const engine = createProjectEngine({
    cwd,
    command: "chat",
    args: [text],
    mode: "plain",
    flags: { ...flags },
  });
  const [scan, context, checkpoints, history] = await Promise.all([
    engine.scan(),
    engine.context(),
    engine.checkpoints(),
    engine.history(20),
  ]);
  const store = createAppStore(cwd);
  store.getState().setScan(scan);
  store.getState().setContext(context);
  if (checkpoints.setup?.steps?.length) {
    store.getState().setSteps(checkpoints.setup.steps);
  } else if (checkpoints.agent?.steps?.length) {
    store.getState().setSteps(checkpoints.agent.steps);
  }
  for (const event of history.slice(-6)) {
    store.getState().addLog({
      type: event.type.includes("error") ? "warning" : "info",
      content: `${event.type}: ${event.message || ""}`,
    });
  }
  store.getState().addMessage({ role: "user", content: redactText(text) });

  if (flags.model) process.env.SETUPR_AI_MODEL = flags.model;

  const result = await handleDirectorInput({
    text,
    cwd,
    scan,
    contextDSL: contextToDSL(context),
    store,
  });

  const messages = store.getState().messages;
  const last = [...messages].reverse().find((message) => message.role === "assistant")
    ?? [...messages].reverse().find((message) => message.role === "thinking");
  const textOut = last?.content || "I did not produce a response.";
  await engine.log("chat.user", text, { action: result.action });
  await engine.log("chat.assistant", textOut, {
    action: result.action,
    level: last?.level || null,
    cost: last?.cost || null,
  });
  return {
    text: textOut,
    action: result.action,
    level: last?.level,
    cost: last?.cost,
    failed: result.failed,
  };
}

function formatChatAnswer(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
