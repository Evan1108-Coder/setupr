import { describe, expect, it } from "vitest";
import { stripHiddenReasoning, extractVisibleAnswer } from "../src/ai/response.js";
import { classifyAIProviderError } from "../src/errors/index.js";

describe("provider answer validation", () => {
  it.each([
    ["<think>private</think>Answer", "Answer"],
    ["<thinking>private</thinking>\nAnswer", "Answer"],
    ["<THINK>private</THINK>Answer", "Answer"],
    ["Before <think>private</think> after", "Before  after"],
    ["<think>outer <thinking>inner</thinking> outer</think>Answer", "Answer"],
    ["Answer<think>unfinished", "Answer"],
    ["<think>unfinished", ""],
    ["<think>```js\nsecret()\n```\n</think>Answer", "Answer"],
    ["<think>`hidden </think>Answer", "Answer"],
    ["</think>Answer", "Answer"],
  ])("removes hidden reasoning from %s", (input, expected) => {
    expect(stripHiddenReasoning(input)).toBe(expected);
  });

  it.each([
    "```xml\n<think>literal</think>\n```",
    "~~~html\n<thinking>literal</thinking>\n~~~",
    "````md\n```xml\n<think>literal\n```\n````",
    "  ```html\n<think>literal\n  ```",
    "Use `<think>` or ``<thinking>`` as literal tags.",
  ])("preserves literal Markdown code: %s", (input) => {
    expect(extractVisibleAnswer(input, "test-model")).toBe(input.trim());
  });

  it("resumes removing reasoning after a fence", () => {
    expect(stripHiddenReasoning("```html\n<think>literal\n```\n<think>secret</think>Answer"))
      .toBe("```html\n<think>literal\n```\nAnswer");
  });

  it.each([undefined, null, "", " \n\t ", "<think>private</think>", "<thinking>unfinished"])(
    "rejects missing or reasoning-only answers: %s", (input) => {
      expect(() => extractVisibleAnswer(input, "test-model")).toThrow(/Invalid response.*no answer/);
    }
  );

  it.each(["length", "max_tokens", "MAX_TOKENS", "max_output_tokens"])(
    "explains truncation without an answer (%s)", (reason) => {
      expect(() => extractVisibleAnswer("<think>private", "test-model", reason)).toThrow(/Increase maxTokens/);
      expect(extractVisibleAnswer("An answer", "test-model", reason)).toBe("An answer");
    }
  );

  it("classifies failures as protocol errors without leaking hidden text", () => {
    let error: unknown;
    try { extractVisibleAnswer("<think>secret internal content</think>", "test-model"); } catch (caught) { error = caught; }
    expect(classifyAIProviderError(error).code).toBe("AI_PROVIDER_PROTOCOL_ERROR");
    expect(String(error)).not.toContain("secret internal content");
  });

  it("supports cleaning old cache entries without provider metadata", () => {
    expect(extractVisibleAnswer("<think>cached reasoning</think>Cached answer")).toBe("Cached answer");
    expect(() => extractVisibleAnswer("<think>cached reasoning")).toThrow(/Invalid response.*no answer/);
  });
});
