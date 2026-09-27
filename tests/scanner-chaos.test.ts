import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { scanProject } from "../src/scanner/index.js";

describe("project scanning with malformed and mixed workspaces", () => {
  let root: string;
  let cwd: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "setupr-scanner-chaos-"));
    cwd = join(root, "project");
    await mkdir(cwd);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const json = (file: string, value: unknown) => writeFile(join(cwd, file), JSON.stringify(value));
  async function pkg(path: string) {
    await mkdir(join(cwd, path), { recursive: true });
    await writeFile(join(cwd, path, "package.json"), JSON.stringify({ name: path.split("/").at(-1) }));
  }

  it.each([null, [], "text", 1, { scripts: ["npm test"] }, { scripts: { dev: 123 } },
    { dependencies: "react" }, { dependencies: { react: {} } }, { name: [] },
    { workspaces: "packages/*" }, { workspaces: { packages: [1] } },
    { packageManager: {} }, { setupr: { packageManager: "npm; echo invalid" } },
    { setupr: { runtime: { name: [] } } }])("rejects invalid package.json structure: %j", async (value) => {
    await json("package.json", value);
    await expect(scanProject(cwd)).rejects.toMatchObject({ code: "MALFORMED_PROJECT_FILE" });
  });

  it.each([null, [], { language: {} }, { framework: [] }, { runtime: {} }, { runtime: { name: "node", version: 20 } }])("rejects malformed project overrides: %j", async (value) => {
    await json(".setupr.json", value);
    await expect(scanProject(cwd)).rejects.toMatchObject({ code: "PROJECT_CONFIG_INVALID" });
  });

  it.each([
    "packages: ['packages/*', '!packages/skip']\n",
    "packages:\n  - packages/* # applications\n  - '!packages/skip' # intentionally excluded\n",
  ])("parses YAML workspace syntax and exclusions", async (yaml) => {
    await writeFile(join(cwd, "pnpm-workspace.yaml"), yaml);
    await pkg("packages/web"); await pkg("packages/skip");
    expect((await scanProject(cwd)).monorepo?.packages).toEqual(["packages/web"]);
  });

  it("deduplicates overlapping globs and sorts workspace packages", async () => {
    await json("package.json", { workspaces: ["packages/*", "packages/a", "!packages/skip"] });
    await pkg("packages/z"); await pkg("packages/a"); await pkg("packages/skip");
    expect((await scanProject(cwd)).monorepo?.packages).toEqual(["packages/a", "packages/z"]);
  });

  it.each(["packages: [broken", "packages: packages/*", "packages: [12]", "just-a-string"])("reports malformed workspace YAML: %s", async (yaml) => {
    await writeFile(join(cwd, "pnpm-workspace.yaml"), yaml);
    await expect(scanProject(cwd)).rejects.toMatchObject({ code: "MALFORMED_PROJECT_FILE" });
  });

  it.each(["../outside/*", "/tmp/*", "C:/outside/*", "packages/../../outside/*"])("rejects workspace path escape: %s", async (pattern) => {
    await json("package.json", { workspaces: [pattern] });
    await expect(scanProject(cwd)).rejects.toMatchObject({ code: "MALFORMED_PROJECT_FILE" });
  });

  it("rejects an external workspace symlink", async () => {
    await json("package.json", { workspaces: ["packages/*"] });
    await mkdir(join(cwd, "packages"));
    const outside = join(root, "outside");
    await mkdir(outside); await writeFile(join(outside, "package.json"), "{}");
    await symlink(outside, join(cwd, "packages/external"), "dir");
    await expect(scanProject(cwd)).rejects.toMatchObject({ code: "MALFORMED_PROJECT_FILE" });
  });

  it("keeps unknown project settings and custom scripts compatible", async () => {
    await json("package.json", { scripts: { "test:unit": "node tests.cjs" }, workspaces: { packages: [] } });
    await json(".setupr.json", { theme: "terminal", runtime: { name: "node", version: null }, custom: { future: true } });
    expect((await scanProject(cwd)).scripts).toEqual({ "test:unit": "node tests.cjs" });
  });
});
