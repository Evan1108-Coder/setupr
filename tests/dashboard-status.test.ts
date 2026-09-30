import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { collectDashboardStatus, createDashboardFallbackStatus } from "../src/status/collector.js";
import { appendHistoryEvent } from "../src/state/project.js";

describe("dashboard/status collector", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "setupr-dashboard-"));
    await writeFile(join(tempDir, "package.json"), JSON.stringify({
      name: "dash-project",
      scripts: { dev: "vite", test: "vitest" },
      dependencies: { react: "^18.0.0" },
      devDependencies: { vite: "^5.0.0" },
    }));
    await writeFile(join(tempDir, ".env.example"), "API_KEY=\nPUBLIC_URL=http://localhost:3000\n");
    await writeFile(join(tempDir, ".env"), "PUBLIC_URL=http://localhost:3000\nEXTRA_FLAG=true\n");
    await appendHistoryEvent(tempDir, { type: "command", message: "ran setup status" });
    await mkdir(join(tempDir, ".setupr"), { recursive: true });
    await writeFile(
      join(tempDir, ".setupr", "processes.json"),
      JSON.stringify([
        {
          id: "web",
          name: "web",
          pid: process.pid,
          status: "running",
          command: "npm run dev",
          cwd: tempDir,
          startedAt: Date.now(),
          logFile: join(tempDir, ".setupr", "logs", "processes", "web.log"),
        },
        {
          id: "api",
          name: "api",
          status: "crashed",
          command: "npm run api",
          cwd: tempDir,
          startedAt: Date.now(),
          logFile: join(tempDir, ".setupr", "logs", "processes", "api.log"),
        },
      ])
    );
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("collects real project, env, dependency, process, and history signals", async () => {
    const status = await collectDashboardStatus(tempDir);

    expect(status.projectName).toBe("dash-project");
    expect(status.hasProject).toBe(true);
    expect(status.scan?.packageManager).toBe("npm");
    expect(status.env.missing).toEqual(["API_KEY"]);
    expect(status.env.extra).toEqual(["EXTRA_FLAG"]);
    expect(status.dependencies.prod).toBe(1);
    expect(status.dependencies.dev).toBe(1);
    expect(status.processes.managed).toBe(2);
    expect(status.processes.running).toBe(1);
    expect(status.processes.crashed).toBe(1);
    expect(status.history.some((event) => event.message === "ran setup status")).toBe(true);
    expect(status.commands.map((command) => command.name)).toContain("setup");
  });

  it("reports git state when the project is a repository", async () => {
    spawnSync("git", ["init", "-b", "main"], { cwd: tempDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: tempDir });
    spawnSync("git", ["add", "package.json"], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "feat: initial"], { cwd: tempDir });
    await writeFile(join(tempDir, "new-file.txt"), "hello\n");

    const status = await collectDashboardStatus(tempDir);

    expect(status.git.isRepo).toBe(true);
    expect(status.git.branch).toBe("main");
    expect(status.git.dirtyFiles).toBeGreaterThan(0);
    expect(status.git.recent[0]).toContain("feat: initial");
  });

  it("creates a bounded fallback dashboard status", () => {
    const status = createDashboardFallbackStatus(tempDir, "timed out");

    expect(status.health.label).toBe("warning");
    expect(status.scanError).toBe("timed out");
    expect(status.commands.map((command) => command.name)).toContain("setup");
  });
});
