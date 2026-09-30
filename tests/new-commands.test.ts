import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, readFile, rm } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { spawnSync } from "child_process";

// Import the router to test command routing
import { runNonTUICommand } from "../src/commands/plain/router.js";
import { SETUPR_PACKAGE_NAME, SETUPR_VERSION } from "../src/version.js";

const TEST_DIR = "/tmp/setupr-test-" + Date.now();

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
  // Create a basic package.json for scanning
  await writeFile(
    join(TEST_DIR, "package.json"),
    JSON.stringify({
      name: "test-project",
      version: "1.0.0",
      scripts: { test: "echo ok", build: "echo built", dev: "echo dev" },
      dependencies: { express: "^4.18.0" },
      devDependencies: { typescript: "^5.0.0" },
    })
  );
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
  process.exitCode = undefined;
});

describe("share command", () => {
  it("should export project config", async () => {
    // Suppress console output
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("share", "export", TEST_DIR, { args: ["test-export.setupr.json"] });
      const exported = join(TEST_DIR, "test-export.setupr.json");
      expect(existsSync(exported)).toBe(true);
      const content = JSON.parse(await readFile(exported, "utf-8"));
      expect(content.name).toBeTruthy();
      expect(content.exportedAt).toBeTruthy();
    } finally {
      console.log = log;
    }
  });

  it("should import and inspect config", async () => {
    // Create a config to import
    const config = {
      name: "imported-project",
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      language: "typescript",
      packageManager: "npm",
      envKeys: ["API_KEY", "DATABASE_URL"],
    };
    await writeFile(join(TEST_DIR, "shared.json"), JSON.stringify(config));

    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("share", "import", TEST_DIR, { args: ["shared.json"] });
      const importedConfig = join(TEST_DIR, ".setupr", "imported.json");
      expect(existsSync(importedConfig)).toBe(true);

      // Check .env.example was created
      const envExample = join(TEST_DIR, ".env.example");
      expect(existsSync(envExample)).toBe(true);
      const envContent = await readFile(envExample, "utf-8");
      expect(envContent).toContain("API_KEY=");
      expect(envContent).toContain("DATABASE_URL=");
    } finally {
      console.log = log;
    }
  });

  it("should import configs from absolute paths", async () => {
    const config = {
      name: "absolute-import",
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      envKeys: ["TOKEN"],
    };
    const absolutePath = join(TEST_DIR, "absolute-share.json");
    await writeFile(absolutePath, JSON.stringify(config));

    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("share", "import", TEST_DIR, { args: [absolutePath] });
      expect(existsSync(join(TEST_DIR, ".setupr", "imported.json"))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});

describe("secrets command", () => {
  it("should initialize secrets", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("secrets", "init", TEST_DIR, { args: [] });
      expect(existsSync(join(TEST_DIR, ".setupr", "secrets.key"))).toBe(true);
      expect(existsSync(join(TEST_DIR, ".gitignore"))).toBe(true);
      expect(await readFile(join(TEST_DIR, ".gitignore"), "utf-8")).toContain(".setupr/secrets.key");
    } finally {
      console.log = log;
    }
  });

  it("should set and get secrets", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("secrets", "init", TEST_DIR, { args: [] });
      await runNonTUICommand("secrets", "set", TEST_DIR, { args: ["MY_SECRET", "super_secret_value"] });
      await runNonTUICommand("secrets", "get", TEST_DIR, { args: ["MY_SECRET"] });
      expect(outputs.some((o) => o.includes("super_secret_value"))).toBe(true);
    } finally {
      console.log = log;
    }
  });

  it("should list secrets", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("secrets", "init", TEST_DIR, { args: [] });
      await runNonTUICommand("secrets", "set", TEST_DIR, { args: ["KEY_ONE", "val1"] });
      await runNonTUICommand("secrets", "set", TEST_DIR, { args: ["KEY_TWO", "val2"] });
      await runNonTUICommand("secrets", "list", TEST_DIR, { args: [] });
      expect(outputs.some((o) => o.includes("KEY_ONE"))).toBe(true);
      expect(outputs.some((o) => o.includes("KEY_TWO"))).toBe(true);
    } finally {
      console.log = log;
    }
  });

  it("should surface corrupt secrets files as structured errors", async () => {
    const outputs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("secrets", "init", TEST_DIR, { args: [] });
      await writeFile(join(TEST_DIR, ".setupr", "secrets.enc"), "{broken");
      await runNonTUICommand("secrets", "list", TEST_DIR, { args: [] });
      expect(outputs.some((o) => o.includes("SECRETS_FILE_CORRUPT"))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});

describe("health command", () => {
  it("should run full health check without crashing", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("health", undefined, TEST_DIR, { args: [] });
    } finally {
      console.log = log;
    }
  });
});

describe("workspace command", () => {
  it("should list workspace packages in monorepo", async () => {
    // Setup a monorepo
    await writeFile(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-monorepo",
        private: true,
        workspaces: ["packages/*"],
        scripts: {},
      })
    );
    await mkdir(join(TEST_DIR, "packages", "core"), { recursive: true });
    await writeFile(
      join(TEST_DIR, "packages", "core", "package.json"),
      JSON.stringify({ name: "@test/core", version: "1.0.0" })
    );

    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("workspace", "list", TEST_DIR, { args: [] });
      expect(outputs.some((o) => o.includes("@test/core") || o.includes("core"))).toBe(true);
    } finally {
      console.log = log;
    }
  });

  it("should count missing src/lib folders as workspace check issues", async () => {
    await writeFile(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test-monorepo", private: true, workspaces: ["packages/*"], scripts: {} })
    );
    await mkdir(join(TEST_DIR, "packages", "core"), { recursive: true });
    await writeFile(join(TEST_DIR, "packages", "core", "package.json"), JSON.stringify({ name: "@test/core", version: "1.0.0" }));

    const outputs: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("workspace", "check", TEST_DIR, { args: [] });
      expect(outputs.join("\n")).toContain("issue(s) found");
    } finally {
      console.log = log;
    }
  });
});

describe("plugin command", () => {
  it("should list plugins when empty", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("plugin", "list", TEST_DIR, { args: [] });
      expect(outputs.some((o) => o.includes("No plugins installed"))).toBe(true);
    } finally {
      console.log = log;
    }
  });

  it("should scaffold and validate plugin projects", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("plugin", "create", TEST_DIR, { args: ["team-tools"] });
      const pluginDir = join(TEST_DIR, "setupr-plugin-team-tools");
      expect(existsSync(join(pluginDir, "package.json"))).toBe(true);
      expect(existsSync(join(pluginDir, "src", "index.ts"))).toBe(true);
      const generated = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
      expect(generated.peerDependencies).toEqual({ [SETUPR_PACKAGE_NAME]: `^${SETUPR_VERSION.split(".")[0]}.0.0` });

      await runNonTUICommand("plugin", "validate", TEST_DIR, { args: [pluginDir] });
      expect(outputs.join("\n")).toContain("Manifest looks valid");
    } finally {
      console.log = log;
    }
  });

  it("should report invalid plugin manifests without throwing", async () => {
    const pluginDir = join(TEST_DIR, "bad-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "bad-plugin" }));

    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("plugin", "validate", TEST_DIR, { args: [pluginDir] });
      expect(outputs.join("\n")).toContain("package.json must include version");
    } finally {
      console.log = log;
    }
  });
});

describe("ci command", () => {
  it("should generate GitHub Actions config", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("ci", "github", TEST_DIR, { args: [] });
      const workflowFile = join(TEST_DIR, ".github", "workflows", "ci.yml");
      expect(existsSync(workflowFile)).toBe(true);
      const content = await readFile(workflowFile, "utf-8");
      expect(content).toContain("name:");
      expect(content).toContain("npm");
    } finally {
      console.log = log;
    }
  });
});

describe("docker command", () => {
  it("should generate Dockerfile", async () => {
    // Ensure scanner detects typescript by adding a .ts file
    await writeFile(join(TEST_DIR, "index.ts"), "console.log('hello');");
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("docker", "generate", TEST_DIR, { args: [] });
      const dockerfile = join(TEST_DIR, "Dockerfile");
      expect(existsSync(dockerfile)).toBe(true);
      const content = await readFile(dockerfile, "utf-8");
      expect(content).toContain("FROM");
      expect(content).toContain("node");
    } finally {
      console.log = log;
    }
  });
});

describe("templates command", () => {
  it("should list templates without crashing", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("templates", "list", TEST_DIR, { args: [] });
    } finally {
      console.log = log;
    }
  });
});

describe("scaffold command", () => {
  it("should create parent directories for nested test paths", async () => {
    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("scaffold", "test", TEST_DIR, { args: ["src/lib/math.ts"] });
      expect(existsSync(join(TEST_DIR, "src", "lib", "math.test.ts"))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});

describe("migrate command", () => {
  it("should error on unsupported migration target", async () => {
    const log = console.log;
    const errors: string[] = [];
    console.log = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await runNonTUICommand("migrate", "invalid-pm", TEST_DIR, { args: [] });
      // Should show an error for unsupported PM
      expect(errors.some((e) => e.includes("not supported") || e.includes("MIGRATE") || e.includes("error") || e.includes("Error"))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});

describe("command routing for new commands", () => {
  it("should route to git command", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      // Just test that it routes without crashing — git may not be init'd
      await runNonTUICommand("git", "status", TEST_DIR, { args: [] });
    } catch {
      // Expected: not a git repo
    } finally {
      console.log = log;
    }
  });

  it("should not execute shell metacharacters in git branch names", async () => {
    const marker = join(TEST_DIR, "git-injection-marker");
    spawnSync("git", ["init", "-b", "main"], { cwd: TEST_DIR });
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: TEST_DIR });
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: TEST_DIR });
    await writeFile(join(TEST_DIR, "tracked.txt"), "hello\n");
    spawnSync("git", ["add", "."], { cwd: TEST_DIR });
    spawnSync("git", ["commit", "-m", "feat: initial"], { cwd: TEST_DIR });

    const log = console.log;
    console.log = () => {};
    try {
      await runNonTUICommand("git", "branch", TEST_DIR, { args: ["create", `bad; touch ${marker} #`] });
      expect(existsSync(marker)).toBe(false);
    } finally {
      console.log = log;
    }
  });

  it("should error on unknown command", async () => {
    const log = console.log;
    const outputs: string[] = [];
    console.log = (...args: unknown[]) => outputs.push(args.join(" "));
    try {
      await runNonTUICommand("nonexistent", undefined, TEST_DIR, { args: [] });
      expect(outputs.some((o) => o.includes("UNKNOWN_COMMAND") || o.includes("Unknown command"))).toBe(true);
    } finally {
      console.log = log;
    }
  });
});
