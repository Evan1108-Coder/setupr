import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { PassThrough } from "stream";
import { createCipheriv, randomBytes, scryptSync } from "crypto";
import { cmdSecrets } from "../src/commands/plain/secrets.js";
import { parseEnvPairs } from "../src/env/index.js";

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

describe("Secrets safety with synthetic encrypted fixtures", () => {
  let cwd: string;
  let logs: string[];
  let originalTTY: PropertyDescriptor | undefined;

  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "setupr-secrets-chaos-"));
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    originalTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    process.exitCode = undefined;
    await cmdSecrets("init", cwd, {});
    logs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (originalTTY) Object.defineProperty(process.stdin, "isTTY", originalTTY);
    else delete (process.stdin as { isTTY?: boolean }).isTTY;
    process.exitCode = undefined;
    await rm(cwd, { recursive: true, force: true });
  });

  it("lists an initialized but empty store without claiming decryption failed", async () => {
    await cmdSecrets("list", cwd, {});
    expect(logs.join("\n")).toContain("No secrets stored.");
    expect(process.exitCode).not.toBe(1);
  });

  it("round-trips encrypted multiline, hash, quotes, whitespace and literal slash sequences", async () => {
    const values = {
      PRIVATE_KEY: "  synthetic line one\nNOT_A_KEY=part # literal\nlast  ",
      API_TOKEN: String.raw`synthetic\n literal # "quoted"`,
    };
    await writeFile(join(cwd, "input.env"), `export PRIVATE_KEY='${values.PRIVATE_KEY}' # comment\nAPI_TOKEN='${values.API_TOKEN}'\nPUBLIC_PORT=3000\n`);
    await cmdSecrets("import", cwd, { args: ["input.env"] });
    expect(process.exitCode).not.toBe(1);
    const encrypted = await readFile(join(cwd, ".setupr", "secrets.enc"), "utf8");
    expect(encrypted).not.toContain("synthetic");
    for (const [key, value] of Object.entries(values)) {
      logs = [];
      await cmdSecrets("get", cwd, { args: [key] });
      expect(logs).toEqual([value]);
    }
    await cmdSecrets("export", cwd, { args: ["output.env"] });
    expect(process.exitCode).not.toBe(1);
    expect(parseEnvPairs(await readFile(join(cwd, "output.env"), "utf8"))).toEqual(values);
    expect((await stat(join(cwd, "output.env"))).mode & 0o777).toBe(0o600);
  });

  it("preserves comments, exports, unrelated data and the effective duplicate on export", async () => {
    await cmdSecrets("set", cwd, { args: ["API_KEY", "synthetic#new\nvalue"] });
    const original = "# local\r\nAPI_KEY=first\r\nexport API_KEY = old # keep\r\nEXTRA='untouched#value'\r\nnot an assignment\r\n\r\n";
    await writeFile(join(cwd, "custom.env"), original);
    await cmdSecrets("export", cwd, { args: ["custom.env"] });
    const saved = await readFile(join(cwd, "custom.env"), "utf8");
    expect(saved).toContain("# local\r\nAPI_KEY=first\r\nexport API_KEY = ");
    expect(saved).toContain(" # keep\r\nEXTRA='untouched#value'\r\nnot an assignment\r\n\r\n");
    expect(parseEnvPairs(saved)).toEqual({ API_KEY: "synthetic#new\nvalue", EXTRA: "untouched#value" });
  });

  it("does not print a prefix or length-dependent fragment in list output", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "pfx1-synthetic-password"] });
    logs = [];
    await cmdSecrets("list", cwd, {});
    expect(logs.join("\n")).not.toContain("pfx1");
    expect(logs.join("\n")).toContain("PASSWORD");
    expect(logs.join("\n")).toContain("[hidden]");
  });

  it.each(["__proto__", "constructor", "toString"])("safely stores, gets, exports and removes own key %s", async (name) => {
    await cmdSecrets("set", cwd, { args: [name, "synthetic-value"] });
    logs = [];
    await cmdSecrets("get", cwd, { args: [name] });
    expect(logs).toEqual(["synthetic-value"]);
    await cmdSecrets("export", cwd, {});
    expect(parseEnvPairs(await readFile(join(cwd, ".env"), "utf8"))[name]).toBe("synthetic-value");
    await cmdSecrets("remove", cwd, { args: [name] });
    logs = [];
    await cmdSecrets("get", cwd, { args: [name] });
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("SECRETS_DECRYPTION_FAILED");
    expect(logs.join("\n")).not.toContain("native code");
  });

  it.each([
    ["set", ["PASSWORD"]],
    ["set", ["PASSWORD", ""]],
    ["set", ["BAD\nINJECTED", "synthetic"]],
    ["get", []],
    ["remove", []],
    ["get", ["constructor"]],
    ["remove", ["constructor"]],
    ["import", ["missing.env"]],
    ["export", ["missing-store.env"]],
  ] as const)("reports structured failure for %s %j", async (subcommand, args) => {
    await cmdSecrets(subcommand, cwd, { args: [...args] });
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toMatch(/Code: [A-Z_]+/);
    expect(logs.join("\n")).not.toContain("native code");
  });

  it("fails an import with missing secret values without changing encrypted data", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "synthetic-existing"] });
    const original = await readFile(join(cwd, ".setupr", "secrets.enc"), "utf8");
    await writeFile(join(cwd, "input.env"), "API_KEY=\n");
    await cmdSecrets("import", cwd, { args: ["input.env"] });
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, ".setupr", "secrets.enc"), "utf8")).toBe(original);
  });

  it("preserves existing export data when a value cannot be safely serialized", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "'\"`#synthetic"] });
    await writeFile(join(cwd, ".env"), "KEEP=original\n");
    logs = [];
    await cmdSecrets("export", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("KEEP=original\n");
    expect(logs.join("\n")).not.toContain("#synthetic");
    expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses symlink export without modifying its target", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "synthetic"] });
    await writeFile(join(cwd, "target"), "KEEP=original\n");
    await symlink(join(cwd, "target"), join(cwd, ".env"));
    await cmdSecrets("export", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, "target"), "utf8")).toBe("KEEP=original\n");
  });

  it("preserves the original and removes temporary plaintext when export replacement fails", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "synthetic-password"] });
    await writeFile(join(cwd, "custom.env"), "KEEP=original\n");
    vi.mocked(fs.rename).mockRejectedValueOnce(new Error("Synthetic replacement failure"));
    await cmdSecrets("export", cwd, { args: ["custom.env"] });
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, "custom.env"), "utf8")).toBe("KEEP=original\n");
    expect((await readdir(cwd)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(logs.join("\n")).not.toContain("synthetic-password");
  });

  it.each(["secrets.key", "secrets.enc"])("refuses exporting plaintext over %s", async (name) => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "synthetic-password"] });
    const path = join(cwd, ".setupr", name);
    const original = await readFile(path, "utf8");
    await cmdSecrets("export", cwd, { args: [path] });
    expect(process.exitCode).toBe(1);
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it.each(["null", "[]", '{"PASSWORD":123}', "{decrypted-sensitive-marker"])("rejects invalid decrypted payload without leaking it: %j", async (plaintext) => {
    const hex = (await readFile(join(cwd, ".setupr", "secrets.key"), "utf8")).trim();
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", scryptSync(hex, "setupr-salt", 32), iv);
    const data = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
    await writeFile(join(cwd, ".setupr", "secrets.enc"), JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data }));
    await cmdSecrets("list", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).toContain("SECRETS_FILE_CORRUPT");
    expect(logs.join("\n")).not.toContain("decrypted-sensitive-marker");
  });

  it("keeps legacy non-env names readable but never silently renames them on export", async () => {
    const hex = (await readFile(join(cwd, ".setupr", "secrets.key"), "utf8")).trim();
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-gcm", scryptSync(hex, "setupr-salt", 32), iv);
    const data = cipher.update('{"legacy-name":"synthetic-value"}', "utf8", "hex") + cipher.final("hex");
    await writeFile(join(cwd, ".setupr", "secrets.enc"), JSON.stringify({ iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data }));
    await cmdSecrets("get", cwd, { args: ["legacy-name"] });
    expect(logs).toEqual(["synthetic-value"]);
    await writeFile(join(cwd, ".env"), "KEEP=original\n");
    await cmdSecrets("export", cwd, {});
    expect(process.exitCode).toBe(1);
    expect(await readFile(join(cwd, ".env"), "utf8")).toBe("KEEP=original\n");
  });

  it("uses a fresh hidden readline prompt without echo or retained history and preserves whitespace", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const originalInput = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const value = "  synthetic-hidden-password  ";
    try {
      const command = cmdSecrets("set", cwd, { args: ["PASSWORD"] });
      await vi.waitFor(() => expect(output.mock.calls.some(([chunk]) => String(chunk).includes("Value for PASSWORD:"))).toBe(true));
      input.write(`discarded-sensitive-value\x15${value}\r`);
      await command;
      const second = cmdSecrets("set", cwd, { args: ["OTHER_PASSWORD"] });
      await vi.waitFor(() => expect(output.mock.calls.some(([chunk]) => String(chunk).includes("Value for OTHER_PASSWORD:"))).toBe(true));
      input.write("\x1b[A\x19second-synthetic-value\r");
      await second;
      expect(process.exitCode).not.toBe(1);
      const displayed = output.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(displayed).not.toContain("synthetic-hidden-password");
      expect(displayed).not.toContain("discarded-sensitive-value");
      expect(displayed).not.toContain("second-synthetic-value");
      expect(input.setRawMode).toHaveBeenCalledWith(true);
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      logs = [];
      await cmdSecrets("get", cwd, { args: ["PASSWORD"] });
      expect(logs).toEqual([value]);
      logs = [];
      await cmdSecrets("get", cwd, { args: ["OTHER_PASSWORD"] });
      expect(logs).toEqual(["second-synthetic-value"]);
    } finally {
      input.destroy();
      Object.defineProperty(process, "stdin", originalInput);
    }
  });

  it("aborts a hidden prompt without changing existing encrypted data", async () => {
    await cmdSecrets("set", cwd, { args: ["PASSWORD", "original-synthetic-value"] });
    const original = await readFile(join(cwd, ".setupr", "secrets.enc"), "utf8");
    vi.stubEnv("TERM", "xterm-256color");
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
    const originalInput = Object.getOwnPropertyDescriptor(process, "stdin")!;
    Object.defineProperty(process, "stdin", { configurable: true, value: input });
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const command = cmdSecrets("set", cwd, { args: ["PASSWORD"] });
      await vi.waitFor(() => expect(output.mock.calls.some(([chunk]) => String(chunk).includes("Value for PASSWORD:"))).toBe(true));
      input.write("discarded-synthetic-password\x03");
      await command;
      expect(process.exitCode).toBe(130);
      expect(logs.join("\n")).toContain("COMMAND_ABORTED");
      expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("discarded-synthetic-password");
      expect(input.setRawMode).toHaveBeenLastCalledWith(false);
      expect(await readFile(join(cwd, ".setupr", "secrets.enc"), "utf8")).toBe(original);
    } finally {
      input.destroy();
      Object.defineProperty(process, "stdin", originalInput);
    }
  });
});
