import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirectorInput } from "../src/ai/director.js";
import { sanitizeForAI } from "../src/ai/directorContext.js";
import type { intelligentResponse } from "../src/ai/intelligence.js";
import { createAppStore } from "../src/state/store.js";
import type { ScanResult } from "../src/scanner/index.js";

const mocks = vi.hoisted(() => ({
  intelligentResponse: vi.fn<typeof intelligentResponse>(),
  updateConfig: vi.fn(),
  chat: vi.fn(),
}));
vi.mock("../src/ai/intelligence.js", () => ({ intelligentResponse: mocks.intelligentResponse }));
vi.mock("../src/ai/client.js", () => ({ chat: mocks.chat, hasAIKey: () => false }));
vi.mock("../src/state/config.js", () => ({ updateConfig: mocks.updateConfig }));
vi.mock("../src/ai/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/models.js")>();
  return {
    ...actual,
    getProviderEnvValue: () => undefined,
    getAvailableModels: () => [],
    isModelAvailable: () => false,
    describeDefaultModelSelection: () => "fixture-selected-model",
    resolveModel: () => undefined,
  };
});

const scan: ScanResult = {
  language: "JavaScript", framework: "React", packageManager: "npm",
  runtime: { name: "node", version: "20" }, services: [], monorepo: null,
  scripts: { build: "vite build" }, dependencies: { prod: 1, dev: 1 }, configFiles: ["package.json"],
};
const answer = { response: "A conversational answer", level: "live" as const, cost: 0.00002 };

function input(text = "Explain the architectural tradeoffs") {
  const store = createAppStore("/test/director-project");
  store.getState().setSteps([
    { id: "deps", label: "Install dependencies", type: "deps", command: "npm install", status: "pending" },
    { id: "build", label: "Run build", type: "script", command: "npm run build", status: "pending" },
  ]);
  return { text, cwd: "/test/director-project", scan, contextDSL: "js/react/npm", store };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.intelligentResponse.mockResolvedValue(answer);
});

afterEach(() => {
  expect(mocks.chat).not.toHaveBeenCalled();
  expect(mocks.updateConfig).not.toHaveBeenCalled();
});

describe("director conversation routing", () => {
  it.each(["How do I use this project?", "Can I use Redis for caching?", "Why use npm here?"])(
    "answers no-op plan wording instead of claiming to adjust the plan: %s", async (text) => {
      const request = input(text);
      const originalSteps = structuredClone(request.store.getState().steps);
      await expect(handleDirectorInput(request)).resolves.toEqual({ handled: true, action: "answer" });
      expect(mocks.intelligentResponse).toHaveBeenCalledWith(text, scan, "js/react/npm", expect.any(Object));
      expect(request.store.getState().steps).toEqual(originalSteps);
      expect(request.store.getState().messages).toHaveLength(1);
      expect(request.store.getState().messages[0]).toMatchObject({ role: "assistant", content: answer.response });
    }
  );

  it("keeps genuine plan changes local", async () => {
    const request = input("skip build");
    expect((await handleDirectorInput(request)).action).toBe("plan.adjust");
    expect(request.store.getState().steps.find((step) => step.id === "build")?.status).toBe("skipped");
    expect(mocks.intelligentResponse).not.toHaveBeenCalled();
  });

  it("leaves a pending prompt intact when answering a use question", async () => {
    const request = input("How do I use this project?");
    request.store.getState().setPendingPrompt({
      id: "confirm-plan", type: "confirm", title: "Confirm setup plan",
      options: [{ id: "proceed", label: "Proceed" }, { id: "cancel", label: "Cancel" }],
      includeOther: true, createdAt: 0,
    });
    expect((await handleDirectorInput(request)).action).toBe("answer");
    expect(request.store.getState().pendingPrompt?.id).toBe("confirm-plan");
    expect(request.store.getState().promptResponse).toBeNull();
  });

  it("forwards a bounded, sanitized user/assistant history without repeating the current turn", async () => {
    const request = input();
    const state = request.store.getState();
    for (let index = 0; index < 16; index++) {
      state.addMessage({ role: index % 2 ? "assistant" : "user", content: `Earlier turn ${index}` });
    }
    state.addMessage({ role: "system", content: "Internal system note" });
    state.addMessage({ role: "thinking", content: "Internal reasoning note" });
    state.addMessage({ role: "steer", content: "Internal steering note" });
    state.addMessage({ role: "user", content: "Earlier token sk-testhistory123456" });
    state.addMessage({ role: "assistant", content: `${"x".repeat(5000)} visible tail sk-testassistant12345` });
    state.addMessage({ role: "user", content: request.text });
    await handleDirectorInput(request);

    const options = mocks.intelligentResponse.mock.calls[0][3];
    if (Array.isArray(options)) throw new Error("Director must pass named intelligence options");
    const history = options?.messages ?? [];
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThanOrEqual(12);
    expect(history.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
    expect(history.every((message) => message.content.length <= 4000)).toBe(true);
    expect(history.some((message) => message.content === request.text)).toBe(false);
    expect(history.some((message) => message.content === "Earlier turn 0")).toBe(false);
    expect(history.at(-2)).toEqual({ role: "user", content: "Earlier token sk-****" });
    expect(history.at(-1)?.role).toBe("assistant");
    expect(history.at(-1)?.content).toHaveLength(4000);
    expect(history.at(-1)?.content).toMatch(/visible tail sk-\*\*\*\*$/);
    const outbound = JSON.stringify(options);
    expect(outbound).not.toContain("sk-testhistory123456");
    expect(outbound).not.toContain("sk-testassistant12345");
  });

  it("deduplicates the sanitized current user message stored by the TUI", async () => {
    const request = input("Explain this token sk-testcurrent123456");
    request.store.getState().addMessage({ role: "user", content: sanitizeForAI(request.text) });
    await handleDirectorInput(request);
    const options = mocks.intelligentResponse.mock.calls[0][3];
    if (Array.isArray(options)) throw new Error("Director must pass named intelligence options");
    expect(options?.messages).toEqual([]);
    expect(options?.directorContext).not.toContain("sk-testcurrent123456");
  });

  it("forwards progress and cancellation options to intelligence", async () => {
    const request = input();
    const controller = new AbortController();
    const onProgress = vi.fn();
    mocks.intelligentResponse.mockImplementation(async (_query, _scan, _context, options) => {
      if (!Array.isArray(options)) options?.onProgress?.("Waiting for fixture model");
      return answer;
    });
    await handleDirectorInput({ ...request, signal: controller.signal, onProgress });
    expect(mocks.intelligentResponse.mock.calls[0][3]).toMatchObject({ signal: controller.signal, onProgress });
    expect(onProgress).toHaveBeenCalledWith("Waiting for fixture model");
  });

  it("does not append a late answer after the user cancels", async () => {
    const request = input();
    const controller = new AbortController();
    mocks.intelligentResponse.mockImplementation(async () => {
      controller.abort();
      return answer;
    });
    await expect(handleDirectorInput({ ...request, signal: controller.signal })).rejects.toBeInstanceOf(DOMException);
    expect(request.store.getState().messages).toEqual([]);
  });

  it("propagates cancellation without rendering it as a failure message", async () => {
    const request = input();
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    mocks.intelligentResponse.mockImplementation(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(handleDirectorInput({ ...request, signal: controller.signal })).rejects.toBe(reason);
    expect(request.store.getState().messages).toEqual([]);
  });

  it("does not route pre-cancelled input", async () => {
    const request = input();
    const controller = new AbortController();
    controller.abort();
    await expect(handleDirectorInput({ ...request, signal: controller.signal })).rejects.toBe(controller.signal.reason);
    expect(mocks.intelligentResponse).not.toHaveBeenCalled();
    expect(request.store.getState().messages).toEqual([]);
  });
});
