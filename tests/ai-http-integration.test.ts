import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chat } from "../src/ai/client.js";
import { PROVIDERS } from "../src/ai/models.js";

vi.mock("../src/state/config.js", () => ({ loadConfig: async () => ({ ai: { maxRetries: 0, retryDelayMs: 1, timeoutMs: 2000, rateLimitPerMinute: 0 } }) }));
vi.mock("../src/ai/models.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ai/models.js")>();
  return { ...actual, PROVIDERS: { ...actual.PROVIDERS, openai: { ...actual.PROVIDERS.openai } },
    getProviderEnvValue: () => "synthetic-integration-key",
    getDefaultModel: () => actual.resolveModel("gpt-4o-mini"),
  };
});

let handle: (request: IncomingMessage, response: ServerResponse) => void;
const server = createServer((request, response) => handle(request, response));
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  PROVIDERS.openai.baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("real SDK over loopback HTTP, no external provider credentials", () => {
  it("sends conversation roles and renders only the final answer", async () => {
    let received: Record<string, unknown> = {};
    handle = (request, response) => {
      let body = "";
      request.on("data", (part) => { body += part; });
      request.on("end", () => {
        received = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "<think>hidden fixture</think>Use the project's dev script." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 8 } }));
      });
    };
    const messages = [{ role: "user" as const, content: "What next?" }, { role: "assistant" as const, content: "Configure the port." }, { role: "user" as const, content: "And then?" }];
    const result = await chat(messages, { maxRetries: 0 });
    expect(result.content).toBe("Use the project's dev script.");
    expect(received.messages).toEqual(messages);
    expect(received.model).toBe("gpt-4o-mini");
  });

  it("aborts an actual pending HTTP request and accepts the next request", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    handle = () => { started(); };
    const controller = new AbortController();
    const pending = chat([{ role: "user", content: "wait" }], { signal: controller.signal, timeoutMs: 5000, maxRetries: 0 });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await ready;
    controller.abort();
    await rejected;
    handle = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "Recovered" } }] }));
    };
    await expect(chat([{ role: "user", content: "retry" }], { maxRetries: 0 })).resolves.toMatchObject({ content: "Recovered" });
  });
});
