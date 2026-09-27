import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { EventEmitter } from "events";
import { createInterface } from "readline";
import { PassThrough } from "stream";
import { runNonTUICommand } from "../src/commands/plain/router.js";
import {
  initEnvFile,
  loadEnvEditorState,
  mergeEnvEditorValues,
  parseEnvKeys,
  parseEnvPairs,
  saveEnvEditorEntries,
} from "../src/env/index.js";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

vi.mock("readline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("readline")>();
  return { ...actual, createInterface: vi.fn(actual.createInterface) };
});

describe("Environment file safety with synthetic fixtures", () => {
  let cwd: string;
  let originalTTY: PropertyDescriptor | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "setupr-env-chaos-"));
    originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(createInterface).mockReset();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    await rm(cwd, { recursive: true, force: true });
  });

  it("ignores malformed assignments and never reports their contents as variable names", () => {
    const content = "# Comment\njust-a-synthetic-secret\nBAD KEY=value\n=value\nexport ONLY_KEY\nGOOD=ok\n";
    expect(parseEnvKeys(content)).toEqual(["GOOD"]);
    expect(parseEnvPairs(content)).toEqual({ GOOD: "ok" });
  });

  it("parses multiline, comments, CRLF, export and duplicates through the same grammar", () => {
    const content = [
      "\uFEFF# Synthetic fixture",
      "export\tTOKEN = \" line one",
      "NOT_A_KEY=inside value",
      "# still inside value\" # outside comment",
      "PLAIN=value#comment",
      "LITERAL='slash\\nvalue # literal' # comment",
      "ESCAPED=\"line\\nnext\\rend\"",
      "DUP=first",
      "DUP=last # effective value",
      "EMPTY= # only a comment",
      "AFTER=ok",
      "",
    ].join("\r\n");
    expect(parseEnvKeys(content)).toEqual(["TOKEN", "PLAIN", "LITERAL", "ESCAPED", "DUP", "EMPTY", "AFTER"]);
    expect(parseEnvPairs(content)).toEqual({
      TOKEN: " line one\nNOT_A_KEY=inside value\n# still inside value",
      PLAIN: "value",
      LITERAL: "slash\\nvalue # literal",
      ESCAPED: "line\nnext\rend",
      DUP: "last",
      EMPTY: "",
      AFTER: "ok",
    });
  });

  it("keeps prototype-shaped keys as ordinary own properties", () => {
    const pairs = parseEnvPairs("__proto__=synthetic\nconstructor=value\ntoString=text\n");
    expect(Object.keys(pairs)).toEqual(["__proto__", "constructor", "toString"]);
    expect(pairs.__proto__).toBe("synthetic");
    expect(pairs.constructor).toBe("value");
  });

  it("does not merge inherited properties and normalizes keys before updating", async () => {
    await writeFile(join(cwd, ".env"), "TOKEN=original\n");
    const { entries } = await loadEnvEditorState(cwd);
    const inherited = Object.create({ TOKEN: "inherited" }) as Record<string, string>;
    expect(mergeEnvEditorValues(entries, inherited)[0].value).toBe("original");
    const merged = mergeEnvEditorValues(entries, { " export TOKEN ": "  synthetic\nvalue  " });
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe("  synthetic\nvalue  ");
  });

  it("does not erase an existing env when forced without an example", async () => {
    const original = "# local-only data\nTOKEN=synthetic\n";
    await writeFile(join(cwd, ".env"), original);
    const result = await initEnvFile(cwd, { overwrite: true });
    expect(result).toMatchObject({ created: false, skipped: true });
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("preserves existing comments, duplicates, unknown lines and exact bytes on a no-op save", async () => {
    const original = "# local comment\r\nTOKEN='synthetic # value' # keep\r\nDUP=old\r\nDUP=current\r\nEMPTY=\r\nnot an assignment\r\n\r\n";
    await writeFile(join(cwd, ".env"), original);
    await writeFile(join(cwd, ".env.example"), "# Template\nTOKEN=\nDUP=default\nEMPTY=default\n");
    const { entries } = await loadEnvEditorState(cwd);
    await saveEnvEditorEntries(cwd, entries);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("updates only the effective duplicate and preserves multiline boundaries and inline comments", async () => {
    const original = "# local\nDUP=first\nexport DUP = last # effective\nCERT='line1\nFAKE=inside\nline3' # certificate\nEXTRA=keep\n";
    await writeFile(join(cwd, ".env"), original);
    await writeFile(join(cwd, ".env.example"), "DUP=default\nCERT=\nADDED=default\n");
    const { entries } = await loadEnvEditorState(cwd);
    await saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { DUP: "new#value", CERT: "replacement\nline2" }));
    const saved = await readFile(join(cwd, ".env"), "utf8");
    expect(saved).toContain("# local\nDUP=first\nexport DUP = ");
    expect(saved).toContain(" # effective\n");
    expect(saved).toContain(" # certificate\nEXTRA=keep\n");
    expect(saved).not.toContain("FAKE=inside");
    expect(parseEnvPairs(saved)).toEqual({ DUP: "new#value", CERT: "replacement\nline2", EXTRA: "keep", ADDED: "default" });
  });

  it.each([
    "synthetic#fragment",
    "  surrounding spaces  ",
    "line one\nINJECTED=still the same value\nlast line",
    String.raw`literal\nsequence\rsequence`,
    'a "double" and a single \' quote # value',
    "`backticks` and 'single' # value",
    "carriage\rreturn",
    "",
  ])("round-trips a synthetic secret without adding assignments: %j", async (value) => {
    await writeFile(join(cwd, ".env"), "TOKEN=old\nKEEP=untouched\n");
    const { entries } = await loadEnvEditorState(cwd);
    await saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { TOKEN: value }));
    expect(parseEnvPairs(await readFile(join(cwd, ".env"), "utf8"))).toEqual({ TOKEN: value, KEEP: "untouched" });
    const reloaded = await loadEnvEditorState(cwd);
    expect(reloaded.entries.find((entry) => entry.key === "TOKEN")?.value).toBe(value);
  });

  it("refuses an invalid key without modifying the existing file", async () => {
    const original = "KEEP=synthetic\n";
    await writeFile(join(cwd, ".env"), original);
    const { entries } = await loadEnvEditorState(cwd);
    await expect(saveEnvEditorEntries(cwd, [{ ...entries[0], key: "EVIL\nINJECTED" }])).rejects.toThrow();
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("uses owner-only permissions for newly created env files", async () => {
    await writeFile(join(cwd, ".env.example"), "TOKEN=synthetic\n", { mode: 0o644 });
    await initEnvFile(cwd);
    expect((await stat(join(cwd, ".env"))).mode & 0o777).toBe(0o600);
  });

  it("preserves newer values and new keys when saving an unrelated edit from stale state", async () => {
    await writeFile(join(cwd, ".env"), "TOKEN=original\nPORT=3000\n");
    const { entries } = await loadEnvEditorState(cwd);
    await writeFile(join(cwd, ".env"), "# external update\nTOKEN=newer\nPORT=3000\nNEW=keep\n");
    await saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { PORT: "4000" }));
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("# external update\nTOKEN=newer\nPORT=4000\nNEW=keep\n");
  });

  it("rejects conflicting edits without exposing values or overwriting the newer file", async () => {
    await writeFile(join(cwd, ".env"), "TOKEN=original\n");
    const { entries } = await loadEnvEditorState(cwd);
    await writeFile(join(cwd, ".env"), "TOKEN=newer\n");
    await expect(saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { TOKEN: "stale-edit" })))
      .rejects.toThrow("changed on disk");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("TOKEN=newer\n");
  });

  it("allows repeated edits after a successful save without reloading", async () => {
    await writeFile(join(cwd, ".env"), "TOKEN=original\n");
    let { entries } = await loadEnvEditorState(cwd);
    entries = mergeEnvEditorValues(entries, { TOKEN: "first" });
    await saveEnvEditorEntries(cwd, entries);
    entries = mergeEnvEditorValues(entries, { TOKEN: "second" });
    await saveEnvEditorEntries(cwd, entries);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("TOKEN=second\n");
  });

  it("leaves existing contents and no temporary secret file after a failed replacement", async () => {
    await writeFile(join(cwd, ".env"), "TOKEN=original\n");
    const { entries } = await loadEnvEditorState(cwd);
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Synthetic rename failure"));
    await expect(saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { TOKEN: "changed" })))
      .rejects.toThrow("Synthetic rename failure");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("TOKEN=original\n");
    expect(await readdir(cwd)).toEqual([".env"]);
  });

  it("refuses symlink updates without modifying the linked file", async () => {
    const target = join(cwd, "target");
    await writeFile(target, "TOKEN=original\n");
    await symlink(target, join(cwd, ".env"));
    const { entries } = await loadEnvEditorState(cwd);
    await expect(saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { TOKEN: "changed" })))
      .rejects.toThrow("non-regular");
    expect(await readFile(target, "utf8")).toBe("TOKEN=original\n");
  });

  it("refuses to write around unterminated quotes without modifying the file", async () => {
    const original = "TOKEN=\"unfinished\nPORT=3000\n";
    await writeFile(join(cwd, ".env"), original);
    const { entries } = await loadEnvEditorState(cwd);
    await expect(saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { PORT: "4000" })))
      .rejects.toThrow("malformed quoted value");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("rejects an unrepresentable value rather than corrupting or disclosing it", async () => {
    const original = "TOKEN=original\n";
    await writeFile(join(cwd, ".env"), original);
    const { entries } = await loadEnvEditorState(cwd);
    await expect(saveEnvEditorEntries(cwd, mergeEnvEditorValues(entries, { TOKEN: "'\"`#synthetic" })))
      .rejects.toThrow("cannot be represented safely");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it.each(["sync", "smart"])("env %s preserves multiline secrets, local comments and extra keys", async (command) => {
    const original = "# local\nTOKEN='synthetic#value' # keep\nCERT='first\nSECOND=part of cert\nlast'\nEXTRA=keep\n";
    await writeFile(join(cwd, ".env"), original);
    await writeFile(join(cwd, ".env.example"), "TOKEN=\nCERT=\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runNonTUICommand("env", command, cwd, {});
    expect(process.exitCode).not.toBe(1);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("env sync appends missing defaults without replacing explicitly empty values", async () => {
    await writeFile(join(cwd, ".env"), "# local\nEMPTY=\nEXTRA=keep\n");
    await writeFile(join(cwd, ".env.example"), "EMPTY=default\nADDED=default\n");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runNonTUICommand("env", "sync", cwd, {});
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("# local\nEMPTY=\nEXTRA=keep\nADDED=default\n");
  });

  it("env sync with force and no example leaves existing data untouched", async () => {
    const original = "# local\nTOKEN=synthetic\n";
    await writeFile(join(cwd, ".env"), original);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runNonTUICommand("env", "sync", cwd, { force: true });
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it.each([
    ["API_KEY=template-sensitive\n", "", "template-sensitive"],
    ["API_KEY=template-sensitive\n", "API_KEY=current-sensitive\n", "current-sensitive"],
    ["API_KEY=\n", "API_KEY=sh0rt\n", "sh0rt"],
    ["DATABASE_URL=postgres://template-user:template-pass@localhost/db\n", "DATABASE_URL=postgres://user:synthetic-password@localhost/db\n", "synthetic-password"],
  ])("env smart masks sensitive defaults, changed values and invalid values", async (example, env, secret) => {
    await writeFile(join(cwd, ".env.example"), example);
    await writeFile(join(cwd, ".env"), env);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runNonTUICommand("env", "smart", cwd, {});
    const output = logs.mock.calls.flat().join("\n");
    expect(output).not.toContain(secret);
    expect(output).not.toContain("template-sensitive");
    expect(output).toContain("[hidden]");
  });

  it.each(["", "   ", "bad"])("env smart rejects skipped or still-invalid answers and does not write: %j", async (answer) => {
    const original = "# local\nAPI_KEY=\nKEEP=value\n";
    await writeFile(join(cwd, ".env.example"), "API_KEY=\n");
    await writeFile(join(cwd, ".env"), original);
    mockAnswers([answer]);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runNonTUICommand("env", "smart", cwd, {});
    expect(process.exitCode).toBe(1);
    const output = logs.mock.calls.flat().join("\n");
    expect(output).toContain("ENV_SMART_FAILED");
    expect(output).not.toContain("Saved .env");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("env smart preserves whitespace in answers, hides typed secrets, and writes through the env editor", async () => {
    await writeFile(join(cwd, ".env.example"), "API_KEY=\nPORT=3000\n");
    await writeFile(join(cwd, ".env"), "# local\nAPI_KEY=\nPORT=3000\nEXTRA=keep\n");
    const answer = "  synthetic-secret#fragment  ";
    mockAnswers([answer]);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runNonTUICommand("env", "smart", cwd, {});
    expect(process.exitCode).not.toBe(1);
    const output = [...logs.mock.calls.flat(), ...stdout.mock.calls.map(([chunk]) => String(chunk))].join("\n");
    expect(output).not.toContain(answer.trim());
    const saved = await readFile(join(cwd, ".env"), "utf8");
    expect(saved).toContain("# local\n");
    expect(parseEnvPairs(saved)).toEqual({ API_KEY: answer, PORT: "3000", EXTRA: "keep" });
  });

  it("env smart does not create an env from defaults after the user explicitly skips", async () => {
    await writeFile(join(cwd, ".env.example"), "PORT=3000\n");
    mockAnswers([""]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runNonTUICommand("env", "smart", cwd, {});
    expect(process.exitCode).toBe(1);
    await expect(readFile(join(cwd, ".env"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("env smart does not save partial fixes when a later prompt is skipped", async () => {
    const original = "API_KEY=\nPORT=\n";
    await writeFile(join(cwd, ".env.example"), original);
    await writeFile(join(cwd, ".env"), original);
    mockAnswers(["synthetic-fixed-key", ""]);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runNonTUICommand("env", "smart", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("env smart aborts without writing when input closes during a prompt", async () => {
    const original = "API_KEY=\n";
    await writeFile(join(cwd, ".env.example"), original);
    await writeFile(join(cwd, ".env"), original);
    mockAnswers([null]);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runNonTUICommand("env", "smart", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(logs.mock.calls.flat().join("\n")).toContain("cancelled");
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe(original);
  });

  it("uses real readline without echo or secret history, even with redirected stdout", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    await writeFile(join(cwd, ".env.example"), "API_KEY=\nPORT=\n");
    await writeFile(join(cwd, ".env"), "API_KEY=\nPORT=\n");
    const actual = await vi.importActual<typeof import("readline")>("readline");
    vi.mocked(createInterface).mockImplementation(actual.createInterface);
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const originalInput = Object.getOwnPropertyDescriptor(process, "stdin")!;
    const originalOutputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const answer = "synthetic-terminal-value  ";
    try {
      const command = runNonTUICommand("env", "smart", cwd, {});
      await vi.waitFor(() => expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes("API_KEY:"))).toBe(true));
      input.write(`discarded-sensitive-input\x15${answer}\r`);
      await vi.waitFor(() => expect(stdout.mock.calls.some(([chunk]) => String(chunk).includes("PORT:"))).toBe(true));
      input.write("\x1b[A\x15\x19\x154000\r");
      await command;
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain(answer.trim());
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("discarded-sensitive-input");
      expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Saved .env");
      expect(input.setRawMode).toHaveBeenCalledWith(true);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(parseEnvPairs(await readFile(join(cwd, ".env"), "utf8")).API_KEY).toBe(answer);
    } finally {
      input.destroy();
      Object.defineProperty(process, "stdin", originalInput);
      if (originalOutputTTY) Object.defineProperty(process.stdout, "isTTY", originalOutputTTY);
      else delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
  });

  function mockAnswers(answers: (string | null)[]) {
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    vi.mocked(createInterface).mockImplementation((options: any) => {
      const rl = new EventEmitter() as ReturnType<typeof createInterface>;
      rl.question = ((_question: string, callback: (answer: string) => void) => {
        const answer = answers.shift();
        if (answer === null) {
          rl.emit("close");
          return;
        }
        options.output.write(answer ?? "");
        callback(answer ?? "");
      }) as typeof rl.question;
      rl.close = () => { rl.emit("close"); };
      return rl;
    });
  }
});
