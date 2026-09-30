import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { chdir, cwd, env } from "process";
import type { ScanResult } from "../src/scanner/index.js";
import { buildCacheKey, setCache } from "../src/ai/cache.js";
import { intelligentResponse } from "../src/ai/intelligence.js";
import { getActiveModel } from "../src/ai/client.js";

const scan: ScanResult = {
  language: "JavaScript",
  framework: "React",
  packageManager: "npm",
  runtime: { name: "node", version: "20" },
  services: ["PostgreSQL"],
  monorepo: null,
  scripts: { dev: "vite dev", build: "vite build" },
  dependencies: { prod: 2, dev: 4 },
  configFiles: ["package.json"],
};

describe("AI intelligence tiers", () => {
  const originalCwd = cwd();
  const originalEnv = { ...env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setupr-intelligence-"));
    chdir(tempDir);
    env.HOME = join(tempDir, "home");
    await mkdir(env.HOME, { recursive: true });
    for (const key of Object.keys(env)) {
      if (key.endsWith("_API_KEY") || key === "GITHUB_TOKEN" || key === "P_SETUP_AI_MODEL" || key === "SETUPR_AI_MODEL") delete env[key];
    }
  });

  afterEach(async () => {
    chdir(originalCwd);
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, originalEnv);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("answers common project questions with free pattern rules", async () => {
    await expect(intelligentResponse("what is the stack?", scan, "js/react/npm")).resolves.toMatchObject({
      level: "pattern",
      cost: 0,
      response: "This is a JavaScript project using React with npm.",
    });

    await expect(intelligentResponse("how do I start it?", scan, "js/react/npm")).resolves.toMatchObject({
      level: "pattern",
      response: "Run: npm run dev",
    });

    await expect(intelligentResponse("what services are detected?", scan, "js/react/npm")).resolves.toMatchObject({
      level: "pattern",
      response: "Detected services: PostgreSQL",
    });
  });

  it("uses cached AI responses before trying a live provider", async () => {
    const context = JSON.stringify({
      version: 2,
      model: getActiveModel().id,
      contextDSL: "js/react/npm",
      directorContext: "ctx",
      messages: [],
    });
    await setCache(buildCacheKey("explain this weird project", context), "cached explanation", 42);

    const result = await intelligentResponse("explain this weird project", scan, "js/react/npm", {
      directorContext: "ctx",
    });

    expect(result).toEqual({ response: "cached explanation", level: "cached", cost: 0 });
  });

  it("returns a clear setup auth instruction when a live answer needs an API key", async () => {
    const result = await intelligentResponse("analyze the tradeoffs of this custom architecture", scan, "js/react/npm");

    expect(result.level).toBe("pattern");
    expect(result.response).toContain("setupr auth");
  });
});
