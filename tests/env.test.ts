import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { initEnvFile, loadEnvEditorState, mergeEnvEditorValues, parseEnvKeys, parseEnvPairs, saveEnvEditorEntries } from "../src/env/index.js";
import { runNonTUICommand } from "../src/commands/plain/router.js";
import { stripTerminalControlInput } from "../src/tui/terminalInput.js";

describe("Environment helpers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setupr-env-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("creates .env from .env.example", async () => {
    await writeFile(join(tempDir, ".env.example"), "API_KEY=example\n");

    const result = await initEnvFile(tempDir);

    expect(result.created).toBe(true);
    expect(result.source).toBe(".env.example");
    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toBe("API_KEY=example\n");
  });

  it("does not create .env without .env.example unless forced", async () => {
    const result = await initEnvFile(tempDir);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("missing-example");
    await expect(readFile(join(tempDir, ".env"), "utf-8")).rejects.toThrow();

    const forced = await initEnvFile(tempDir, { overwrite: true });
    expect(forced.created).toBe(true);
    expect(forced.source).toBe("empty");
    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toContain("# Environment variables");
  });

  it("does not overwrite an existing .env unless forced", async () => {
    await writeFile(join(tempDir, ".env.example"), "API_KEY=example\n");
    await writeFile(join(tempDir, ".env"), "API_KEY=secret\n");

    const result = await initEnvFile(tempDir);

    expect(result.skipped).toBe(true);
    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toBe("API_KEY=secret\n");

    await initEnvFile(tempDir, { overwrite: true });
    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toBe("API_KEY=example\n");
  });

  it("parses export-prefixed env variables consistently", () => {
    const content = "export API_KEY=abc\nNORMAL=value\n";

    expect(parseEnvKeys(content)).toEqual(["API_KEY", "NORMAL"]);
    expect(parseEnvPairs(content)).toEqual({ API_KEY: "abc", NORMAL: "value" });
  });

  it("splits a multi-line paste (CR line breaks) into distinct vars through the input pipeline", () => {
    // Reproduces the real-terminal env editor flow: a Cmd+V paste arrives wrapped in
    // bracketed-paste guards with CR line breaks. The stripper must normalize it so
    // parseEnvPairs yields three separate vars instead of one mashed-together value.
    const pasted = "\x1b[200~API_KEY=sk-live-9999\rDATABASE_URL=postgres://localhost/db\rPORT=8080\x1b[201~";
    const clean = stripTerminalControlInput(pasted).trim();

    expect(parseEnvPairs(clean)).toEqual({
      API_KEY: "sk-live-9999",
      DATABASE_URL: "postgres://localhost/db",
      PORT: "8080",
    });

    const merged = mergeEnvEditorValues(
      [
        { key: "API_KEY", value: "", status: "empty", sensitive: true, fromTemplate: true, fromEnv: false },
        { key: "DATABASE_URL", value: "", status: "empty", sensitive: false, fromTemplate: true, fromEnv: false },
        { key: "PORT", value: "3000", status: "filled", sensitive: false, fromTemplate: true, fromEnv: true },
      ],
      parseEnvPairs(clean)
    );
    expect(merged.find((entry) => entry.key === "DATABASE_URL")?.value).toBe("postgres://localhost/db");
    expect(merged.find((entry) => entry.key === "PORT")?.value).toBe("8080");
  });

  it("sync preserves existing export-prefixed keys and values", async () => {
    await writeFile(join(tempDir, ".env.example"), "export API_KEY=\nNORMAL=example\n");
    await writeFile(join(tempDir, ".env"), "export API_KEY=secret\nNORMAL=real\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await runNonTUICommand("env", "sync", tempDir, {});

    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toBe("export API_KEY=secret\nNORMAL=real\n");
  });

  it("env smart does not write unresolved variables in non-interactive mode", async () => {
    await writeFile(join(tempDir, ".env.example"), "API_KEY=\n");
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await runNonTUICommand("env", "smart", tempDir, {});
    } finally {
      if (originalIsTTY) {
        Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }

    expect(process.exitCode).toBe(1);
    await expect(readFile(join(tempDir, ".env"), "utf-8")).rejects.toThrow();
  });

  it("loads env editor state from .env and .env.example", async () => {
    await writeFile(join(tempDir, ".env.example"), "# Template\nAPI_KEY=\nPUBLIC_URL=http://localhost:3000\n");
    await writeFile(join(tempDir, ".env"), "API_KEY=sk-secret\nEXTRA_FLAG=yes\n");

    const state = await loadEnvEditorState(tempDir);

    expect(state.hasEnv).toBe(true);
    expect(state.hasExample).toBe(true);
    expect(state.missing).toEqual(["PUBLIC_URL"]);
    expect(state.extra).toEqual(["EXTRA_FLAG"]);
    expect(state.entries.map((entry) => entry.key)).toEqual(["API_KEY", "PUBLIC_URL", "EXTRA_FLAG"]);
    expect(state.entries.find((entry) => entry.key === "API_KEY")?.sensitive).toBe(true);
  });

  it("saves env editor entries while preserving existing structure and appending missing keys", async () => {
    await writeFile(join(tempDir, ".env.example"), "# Template\nexport API_KEY=\nPUBLIC_URL=http://localhost:3000\n");
    await writeFile(join(tempDir, ".env"), "API_KEY=old\nEXTRA_FLAG=yes\n");
    const state = await loadEnvEditorState(tempDir);
    const entries = mergeEnvEditorValues(state.entries, {
      API_KEY: "sk-new",
      PUBLIC_URL: "http://localhost:5173",
      EXTRA_FLAG: "two\nlines",
    });

    await saveEnvEditorEntries(tempDir, entries);

    await expect(readFile(join(tempDir, ".env"), "utf-8")).resolves.toBe(
      "API_KEY=sk-new\nEXTRA_FLAG=\"two\\nlines\"\nPUBLIC_URL=http://localhost:5173\n"
    );
  });
});
