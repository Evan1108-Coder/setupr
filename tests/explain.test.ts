import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { explainResult, redactExplanation, captureCommandOutput } from "../src/cli/explain.js";
import { chat, hasAIKey } from "../src/ai/client.js";
vi.mock("../src/ai/client.js", () => ({ chat: vi.fn(), hasAIKey: vi.fn(() => true) }));
vi.mock("../src/ai/models.js", () => ({ PROVIDERS: { openai: {} }, getProviderEnvValue: () => "provider-secret-example" }));
vi.mock("../src/state/config.js", () => ({ loadConfig: async () => ({ ai: { enabled: true } }) }));
beforeEach(() => { vi.mocked(hasAIKey).mockReturnValue(true); vi.mocked(chat).mockResolvedValue({ content: "The project file is malformed. Fix its JSON before retrying.", model: "test-model", tokens: 30 }); });
afterEach(() => vi.clearAllMocks());
describe("post-command explanation", () => {
  it("explains the actual result once, with no tools and no retries", async () => {
    const result = await explainResult({ command: "info", exitCode: 1, output: "MALFORMED_PROJECT_FILE package.json" });
    expect(result).toContain("AI explanation (advisory; test-model)");
    expect(chat).toHaveBeenCalledTimes(1);
    const [messages, options] = vi.mocked(chat).mock.calls[0];
    expect(JSON.parse(messages[1].content).exitCode).toBe(1);
    expect(options).toMatchObject({ maxRetries: 0, timeoutMs: 30000 });
  });
  it.each(["auth", "secrets", "config"])("never sends %s output", async command => {
    await explainResult({ command, exitCode: 0, output: "private credential" });
    expect(chat).not.toHaveBeenCalled();
  });
  it("does not duplicate a smart/chat AI call", async () => {
    await explainResult({ command: "doctor", smart: true, exitCode: 0, output: "result" });
    await explainResult({ command: "chat", exitCode: 0, output: "answer" });
    expect(chat).not.toHaveBeenCalled();
  });
  it("returns a clear notice when no key exists", async () => {
    vi.mocked(hasAIKey).mockReturnValue(false);
    expect(await explainResult({ command: "info", exitCode: 0, output: "summary" })).toContain("auth login");
    expect(chat).not.toHaveBeenCalled();
  });
  it("contains provider failures without leaking the provider's error payload", async () => {
    vi.mocked(chat).mockRejectedValue(new Error("401 invalid key private-payload"));
    const text = await explainResult({ command: "info", exitCode: 0, output: "summary" });
    expect(text).toContain("unavailable");
    expect(text).not.toContain("private-payload");
  });
  it("redacts credentials, env variants and terminal sequences before transport", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "setupr-explain-"));
    try {
      await writeFile(join(cwd, ".env.development.local"), "ODD_NAME=secret-with-unusual-name\n");
      await explainResult({ command: "info", cwd, exitCode: 0, output: 'secret-with-unusual-name provider-secret-example postgres://user:password@localhost/db\nAPI_KEY=hidden\n{"token":"quoted-secret"}\n\x1b[31mred' });
      const data = vi.mocked(chat).mock.calls[0][0][1].content;
      for (const secret of ["secret-with-unusual-name", "provider-secret-example", "user:password", "quoted-secret", "hidden", "\\u001b"]) expect(data).not.toContain(secret);
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
  it("redacts multi-line private keys", () => expect(redactExplanation("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----")).not.toContain("secret"));
  it("passes output through unchanged and restores stream methods", () => {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const capture = captureCommandOutput();
      process.stdout.write('{"ok":true}\n');
      process.stderr.write("warning\n");
      expect(capture.stop()).toBe('{"ok":true}\nwarning\n');
      expect(process.stdout.write).toBe(stdout);
      expect(stdout).toHaveBeenCalledWith('{"ok":true}\n');
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
  });
});
