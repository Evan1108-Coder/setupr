import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cmdWorkspace } from "../src/commands/plain/workspace.js";
import * as executor from "../src/executor/index.js";

const realRunCommand = executor.runCommand;
const success = { exitCode: 0, stdout: "", stderr: "" };
let tempDir: string;
let cwd: string;
let logs: string[];
let run: MockInstance<typeof executor.runCommand>;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "setupr-workspace-"));
  cwd = join(tempDir, "project");
  await mkdir(cwd);
  await root();
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => logs.push(args.join(" ")));
  run = vi.spyOn(executor, "runCommand").mockResolvedValue(success);
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

async function root(extra: Record<string, unknown> = {}) {
  await writeFile(join(cwd, "package.json"), JSON.stringify({
    name: "acme", private: true, workspaces: ["packages/*"], ...extra,
  }));
}

async function pkg(name: string, scripts: Record<string, string> = { test: "node test.cjs" }) {
  const dir = join(cwd, "packages", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: `@acme/${name}`, version: "1.0.0", scripts }));
  return dir;
}

function output() {
  return logs.join("\n");
}

describe("workspace add", () => {
  it.each(["my-library", "123-library", "class", "utils.core"])("creates valid TypeScript for %s", async (name) => {
    await cmdWorkspace("add", cwd, { args: [name] });

    const source = await readFile(join(cwd, "packages", name, "src/index.ts"), "utf-8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      reportDiagnostics: true,
    });
    expect(compiled.diagnostics?.map(diagnostic => diagnostic.messageText)).toEqual([]);
    expect(() => new Function("exports", compiled.outputText)({})).not.toThrow();
    expect(process.exitCode).toBeUndefined();
  });

  it.each(["../../escaped", "../existing", "nested/name", "..\\escaped", ".", ".."])("rejects unsafe name %s without creating files", async (name) => {
    await cmdWorkspace("add", cwd, { args: [name] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(tempDir, "escaped"))).toBe(false);
    expect(existsSync(join(cwd, "existing"))).toBe(false);
    expect(existsSync(join(cwd, "packages"))).toBe(false);
  });

  it("does not overwrite an existing package, even with force", async () => {
    const dir = await pkg("existing");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src/index.ts"), "export const original = true;\n");
    const manifest = await readFile(join(dir, "package.json"), "utf-8");

    await cmdWorkspace("add", cwd, { args: ["existing"], force: true });

    expect(process.exitCode).toBe(1);
    expect(await readFile(join(dir, "package.json"), "utf-8")).toBe(manifest);
    expect(await readFile(join(dir, "src/index.ts"), "utf-8")).toBe("export const original = true;\n");
  });

  it("leaves an existing non-package directory untouched", async () => {
    const dir = join(cwd, "packages", "existing");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "notes.txt"), "keep");

    await cmdWorkspace("add", cwd, { args: ["existing"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(dir, "package.json"))).toBe(false);
    expect(await readFile(join(dir, "notes.txt"), "utf-8")).toBe("keep");
  });

  it.each(["../outside/*", "packages/../../outside/*"])("rejects an escaping workspace pattern: %s", async (pattern) => {
    await root({ workspaces: [pattern] });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(tempDir, "outside"))).toBe(false);
  });

  it("rejects a workspace base symlink pointing outside the root", async () => {
    const outside = join(tempDir, "outside");
    await mkdir(outside);
    await symlink(outside, join(cwd, "packages"));

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(outside, "new-lib"))).toBe(false);
  });

  it("rejects an escaping intermediate symlink before creating directories", async () => {
    const outside = join(tempDir, "outside");
    await mkdir(outside);
    await symlink(outside, join(cwd, "linked"));
    await root({ workspaces: ["linked/new/packages/*"] });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(outside, "new"))).toBe(false);
  });

  it.each([false, true])("rejects an existing destination symlink (dangling: %s)", async (dangling) => {
    const outside = join(tempDir, "outside");
    if (!dangling) await mkdir(outside);
    await mkdir(join(cwd, "packages"));
    await symlink(outside, join(cwd, "packages", "new-lib"));

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(outside, "package.json"))).toBe(false);
    expect((await lstat(join(cwd, "packages", "new-lib"))).isSymbolicLink()).toBe(true);
  });

  it("uses the root scope rather than nesting a scoped root name", async () => {
    await root({ name: "@acme/root" });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(JSON.parse(await readFile(join(cwd, "packages/new-lib/package.json"), "utf-8")).name).toBe("@acme/new-lib");
  });

  it("reads the destination from pnpm workspace YAML", async () => {
    await root({ workspaces: undefined, packageManager: "pnpm@10.0.0" });
    await writeFile(join(cwd, "pnpm-workspace.yaml"), "packages:\n  - 'modules/*'\n");

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(existsSync(join(cwd, "modules/new-lib/package.json"))).toBe(true);
    expect(existsSync(join(cwd, "packages"))).toBe(false);
  });

  it.each(["!packages/private-*", "!packages", "!packages/**"])("refuses a destination excluded by %s", async (exclusion) => {
    await root({ workspaces: ["packages/*", exclusion] });

    await cmdWorkspace("add", cwd, { args: ["private-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(cwd, "packages/private-lib"))).toBe(false);
  });

  it.each(["packages/**", "{packages,apps}/*", "packages/*/modules/*"])("does not guess a scaffold directory for %s", async (pattern) => {
    await root({ workspaces: [pattern] });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(cwd, "packages"))).toBe(false);
  });

  it("supports object workspace declarations and nested literal parent directories", async () => {
    await root({ workspaces: { packages: ["projects/modules/*/"] } });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(existsSync(join(cwd, "projects/modules/new-lib/package.json"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not create an undiscoverable package when workspace configuration is absent", async () => {
    await root({ workspaces: undefined });

    await cmdWorkspace("add", cwd, { args: ["new-lib"] });

    expect(process.exitCode).toBe(1);
    expect(existsSync(join(cwd, "packages"))).toBe(false);
  });

  it("allows a workspace root reached through a symlink", async () => {
    const alias = join(tempDir, "alias");
    await symlink(cwd, alias);

    await cmdWorkspace("add", alias, { args: ["new-lib"] });

    expect(existsSync(join(cwd, "packages/new-lib/package.json"))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });
});

describe("workspace run and exec", () => {
  it.each(["run", "exec"])("%s fails on an empty workspace", async (sub) => {
    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"] });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(output()).toContain("WORKSPACE_NO_PACKAGES");
  });

  it.each(["run", "exec"])("%s fails when the explicit filter matches nothing", async (sub) => {
    await pkg("core");

    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"], filter: "absent" });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(output()).toContain("absent");
  });

  it.each(["run", "exec"])("%s rejects an empty filter rather than running everywhere", async (sub) => {
    await pkg("core");

    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"], filter: "" });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["add", "run", "exec"])("%s fails when required arguments are absent", async (sub) => {
    await cmdWorkspace(sub, cwd, {});

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("prefers flags.filter and preserves the positional run filter", async () => {
    const core = await pkg("core");
    const ui = await pkg("ui");

    await cmdWorkspace("run", cwd, { args: ["test", "core"], filter: "packages/ui" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe(ui);

    run.mockClear();
    await cmdWorkspace("run", cwd, { args: ["test", "core"] });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe(core);
  });

  it("filters exec without consuming command arguments", async () => {
    const core = await pkg("core");
    await pkg("ui");

    await cmdWorkspace("exec", cwd, { args: ["node", "--version"], filter: "core" });

    expect(run).toHaveBeenCalledExactlyOnceWith("node --version", core);
  });

  it.each(["pnpm", "yarn"])("uses root %s even when children default to npm", async (pm) => {
    await root({ packageManager: `${pm}@1.0.0` });
    await pkg("core");

    await cmdWorkspace("run", cwd, { args: ["test"] });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatch(new RegExp(`^'?${pm}'? run `));
  });

  it.each([["pnpm", "pnpm-lock.yaml"], ["yarn", "yarn.lock"]])("uses %s from the root lockfile", async (pm, lockfile) => {
    await writeFile(join(cwd, lockfile), "");
    await pkg("core");

    await cmdWorkspace("run", cwd, { args: ["test"] });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatch(new RegExp(`^'?${pm}'? run `));
  });

  it.each(["run", "exec"])("%s aggregates failures and still attempts other packages", async (sub) => {
    const core = await pkg("core");
    await pkg("ui");
    run.mockImplementation(async (_command, dir) => dir === core
      ? { exitCode: 7, stdout: "", stderr: "fixture failure" }
      : success);

    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"] });

    expect(run).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("WORKSPACE_COMMAND_FAILED");
    expect(output()).toContain("1 package(s) failed, 1 passed");
  });

  it.each(["run", "exec"])("%s aggregates thrown execution errors", async (sub) => {
    const core = await pkg("core");
    await pkg("ui");
    run.mockImplementation(async (_command, dir) => {
      if (dir === core) throw new Error("fixture spawn failure");
      return success;
    });

    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"] });

    expect(run).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("fixture spawn failure");
  });

  it("fails when every selected package lacks the requested script", async () => {
    await pkg("core", {});

    await cmdWorkspace("run", cwd, { args: ["test"] });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(output()).not.toContain("All 0 package(s) passed");
  });

  it("reports skipped scripts separately from successful packages", async () => {
    await pkg("core");
    await pkg("ui", {});

    await cmdWorkspace("run", cwd, { args: ["test"] });

    expect(process.exitCode).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
    expect(output()).toContain("1 skipped");
  });

  it.each(["run", "exec"])("%s does not silently drop a broken child manifest from the aggregate", async (sub) => {
    const broken = await pkg("broken");
    await pkg("core");
    await writeFile(join(broken, "package.json"), "{broken");

    await cmdWorkspace(sub, cwd, { args: [sub === "run" ? "test" : "node --version"] });

    expect(process.exitCode).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(output()).toContain("1 package(s) failed, 1 passed");
  });

  it.each(["semicolon", "apostrophe", "substitution", "newline"])("quotes %s in script names as a single argument", async (kind) => {
    const marker = join(tempDir, "injected");
    const scripts: Record<string, string> = {
      semicolon: `test; touch ${marker} #`,
      apostrophe: "test'quoted name",
      substitution: `test$(touch ${marker})`,
      newline: `test\ntouch ${marker}`,
    };
    const script = scripts[kind];
    const dir = await pkg("core", { [script]: "ignored by fake npm" });
    const bin = join(tempDir, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "npm"), `#!${process.execPath}\nrequire('fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(join(bin, "npm"), 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    run.mockImplementation(realRunCommand);

    await cmdWorkspace("run", cwd, { args: [script] });

    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "argv.json"), "utf-8"))).toEqual(["run", script]);
    expect(process.exitCode).toBeUndefined();
  });

  it("does not mistake an inherited object property for a script", async () => {
    await pkg("core", {});

    await cmdWorkspace("run", cwd, { args: ["toString"] });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects option-like script names", async () => {
    await pkg("core", { "--help": "node test.cjs" });

    await cmdWorkspace("run", cwd, { args: ["--help"] });

    expect(process.exitCode).toBe(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns a failure exit status for a real local failing exec command", async () => {
    const dir = await pkg("core");
    await writeFile(join(dir, "fail.cjs"), "process.exitCode = 9;\n");
    run.mockImplementation(realRunCommand);

    await cmdWorkspace("exec", cwd, { args: [process.execPath, "fail.cjs"] });

    expect(process.exitCode).toBe(1);
    expect(output()).toContain("1 package(s) failed, 0 passed");
  });
});
