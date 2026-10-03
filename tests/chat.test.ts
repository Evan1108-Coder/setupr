import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { chdir, cwd, env } from "process";
import { askProjectChat } from "../src/commands/plain/chat.js";
import { readRecentLogEvents } from "../src/state/project.js";

describe("setupr chat", () => {
  const originalCwd = cwd();
  const originalEnv = { ...env };
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setupr-chat-"));
    chdir(tempDir);
    env.HOME = join(tempDir, "home");
    await mkdir(env.HOME, { recursive: true });
    for (const key of Object.keys(env)) {
      if (key.endsWith("_API_KEY") || key === "GITHUB_TOKEN" || key === "P_SETUP_AI_MODEL" || key === "SETUPR_AI_MODEL") {
        delete env[key];
      }
    }
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      scripts: { dev: "vite --host 0.0.0.0", build: "vite build", test: "vitest" },
      dependencies: { react: "^18.0.0" },
      devDependencies: { vite: "^5.0.0" },
    }, null, 2));
    await writeFile(join(tempDir, "README.md"), "## Setup\nUse npm install, then npm run dev.\n");
  });

  afterEach(async () => {
    chdir(originalCwd);
    for (const key of Object.keys(env)) delete env[key];
    Object.assign(env, originalEnv);
    await rm(tempDir, { recursive: true, force: true });
  });

  it("answers project questions from deterministic project context without an API key", async () => {
    const answer = await askProjectChat(tempDir, "what is the framework?");

    expect(answer.action).toBe("answer");
    expect(answer.text).toContain("JavaScript");
    expect(answer.level).toBe("pattern");
  });

  it("answers a constrained build-script question without steering or contacting AI", async () => {
    const answer = await askProjectChat(tempDir, "Which scripts does this project provide? Name the build script only, without running it.");
    expect(answer.action).toBe("answer");
    expect(answer.level).toBe("pattern");
    expect(answer.failed).toBeUndefined();
    expect(answer.text).toContain("npm run build");
    expect(answer.text).not.toContain("skip");
  });

  it("can steer model choice from plain chat", async () => {
    env.MINIMAX_API_KEY = "minimax-test-key";
    const answer = await askProjectChat(tempDir, "switch model to minimax-m2.5");

    expect(answer.action).toBe("model.switch");
    expect(env.SETUPR_AI_MODEL).toBe("minimax-m2.5");
    expect(answer.text).toContain("Switched to minimax-m2.5");
  });

  it("records chat logs with secrets redacted", async () => {
    await askProjectChat(tempDir, "OPENAI_API_KEY=sk-secret-value");

    const logs = await readRecentLogEvents(tempDir, 10);
    expect(JSON.stringify(logs)).not.toContain("sk-secret-value");
  });
});
