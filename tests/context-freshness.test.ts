import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync } from "child_process";
import { scanProject } from "../src/scanner/index.js";
import { collectContext } from "../src/context/collector.js";

describe("cached director context stays accurate", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "setupr-context-freshness-"));
    await writeFile(join(cwd, "package.json"), "{}");
  });
  afterEach(async () => { await rm(cwd, { force: true, recursive: true }); });
  async function context() { return collectContext(cwd, await scanProject(cwd)); }

  it("refreshes env values without treating multiline contents as keys", async () => {
    await writeFile(join(cwd, ".env.example"), 'EMPTY=\nCERT="first\nNOT_A_KEY=still cert\nlast"\n');
    await writeFile(join(cwd, ".env"), 'EMPTY=\nCERT="first\nNOT_A_KEY=still cert\nlast"\n');
    const first = await context();
    expect(first.envVars.templateKeys).toEqual(["EMPTY", "CERT"]);
    expect(first.envVars.missing).toEqual(["EMPTY"]);
    await writeFile(join(cwd, ".env"), 'EMPTY=now-set\nCERT="content"\n');
    const second = await context();
    expect(second.cacheHit).toBe(true);
    expect(second.envVars.missing).toEqual([]);
  });

  it("refreshes git remotes from cache without persisting credentials", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
    git("init", "-b", "main");
    git("remote", "add", "upstream", "https://username:fixture-password@github.com/example/first.git");
    const first = await context();
    expect(first.git.remoteUrl).toBe("https://github.com/example/first.git");
    expect(await readFile(join(cwd, ".setupr/cache/project-context.json"), "utf8")).not.toContain("fixture-password");
    git("remote", "set-url", "upstream", "https://github.com/example/second.git");
    expect((await context()).git.remoteUrl).toBe("https://github.com/example/second.git");
  });

  it("refreshes new files while reusing documentation compression", async () => {
    await context();
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src/new-file.js"), "export const value = 1;");
    const next = await context();
    expect(next.cacheHit).toBe(true);
    expect(next.fileTree).toContain("src/new-file.js");
  });

  it("invalidates documentation cache when setup notes change", async () => {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs/onboarding.md"), "Run npm install.");
    await context();
    await writeFile(join(cwd, "docs/onboarding.md"), "Run docker compose up, then npm install.");
    const next = await context();
    expect(next.cacheHit).toBe(false);
    expect(next.documents?.find(doc => doc.path === "docs/onboarding.md")?.excerpt).toContain("docker compose up");
  });

  it("does not read oversized nested documentation", async () => {
    await mkdir(join(cwd, "docs"));
    await writeFile(join(cwd, "docs/large.md"), "x".repeat(512001));
    expect((await context()).documents?.some(doc => doc.path === "docs/large.md")).toBe(false);
  });
});
