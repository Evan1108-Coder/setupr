import chalk from "chalk";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { basename, join, relative, resolve } from "path";
import { createSetuprError, printPlainError } from "../../errors/index.js";
import { loadConfig, saveConfig } from "../../state/config.js";
import { runCommandArgs } from "../../executor/index.js";
import { loadEnabledPlugins } from "../../plugins/runtime.js";
import { SETUPR_PACKAGE_NAME, SETUPR_VERSION } from "../../version.js";

interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  hooks?: string[];
  commands?: string[];
  keywords?: string[];
  main?: string;
  exports?: unknown;
  setupr?: {
    apiVersion?: string;
    commands?: string[];
    scanners?: string[];
    planners?: string[];
    doctorChecks?: string[];
    fixers?: string[];
    panels?: string[];
  };
}

export async function cmdPlugin(
  sub: string | undefined,
  cwd: string,
  flags: { args?: string[]; force?: boolean }
): Promise<void> {
  switch (sub) {
    case "install":
      await pluginInstall(cwd, flags);
      break;
    case "remove":
      await pluginRemove(cwd, flags);
      break;
    case "list":
      await pluginList(cwd);
      break;
    case "info":
      await pluginInfo(cwd, flags);
      break;
    case "enable":
      await pluginToggle(cwd, flags, true);
      break;
    case "disable":
      await pluginToggle(cwd, flags, false);
      break;
    case "create":
    case "scaffold":
      await pluginCreate(cwd, flags);
      break;
    case "validate":
      await pluginValidate(cwd, flags);
      break;
    case "doctor":
      await pluginDoctor(cwd);
      break;
    default:
      printPlainError(
        createSetuprError({
          code: "UNKNOWN_SUBCOMMAND",
          command: "plugin",
          subcommand: sub,
          cwd,
          details: ["Valid subcommands: install, remove, list, info, enable, disable, create, validate, doctor."],
        })
      );
  }
}

async function pluginInstall(cwd: string, flags: { args?: string[]; force?: boolean }): Promise<void> {
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: "install",
        cwd,
        details: ["Usage: setup plugin install <name|url>"],
      })
    );
    return;
  }

  const pluginsDir = join(cwd, ".setupr", "plugins");
  await mkdir(pluginsDir, { recursive: true });

  const isGitSource = name.startsWith("http://")
    || name.startsWith("https://")
    || name.startsWith("git@")
    || name.startsWith("ssh://")
    || name.endsWith(".git");

  try {
    let pluginDir: string;
    let registeredName = name;
    if (isGitSource) {
      pluginDir = join(pluginsDir, name.split("/").pop()?.replace(/\.git$/, "") || "plugin");
      await runCommandArgs("git", ["clone", "--depth", "1", name, pluginDir], cwd);
      registeredName = await readPluginPackageName(pluginDir).catch(() => basename(pluginDir));
      console.log(chalk.green(`✓ Installed plugin from ${name}`));
    } else {
      // npm-style install from registry
      pluginDir = join(pluginsDir, name.replace(/[\\/]/g, "__"));
      await mkdir(pluginDir, { recursive: true });
      const result = await runCommandArgs("npm", ["pack", name, "--pack-destination", pluginDir], cwd);
      if (result.exitCode !== 0) {
        printPlainError(
          createSetuprError({
            code: "PLUGIN_REGISTRY_FAILED",
            command: "plugin",
            subcommand: "install",
            cwd,
            details: [`Could not install '${name}' from npm registry.`, result.stderr],
          })
        );
        return;
      }
      registeredName = name;
      console.log(chalk.green(`✓ Installed plugin: ${name}`));
    }

    // Register in config
    const config = await loadConfig();
    const plugins = config.plugins || [];
    const existing = plugins.find((p) => p.name === registeredName);
    if (!existing) {
      plugins.push({
        name: registeredName,
        version: "latest",
        enabled: true,
        source: relative(cwd, pluginDir),
      });
      config.plugins = plugins;
      await saveConfig(config);
    }
  } catch (err) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_LOAD_FAILED",
        command: "plugin",
        subcommand: "install",
        cwd,
        details: [err instanceof Error ? err.message : String(err)],
      })
    );
  }
}

async function readPluginPackageName(pluginDir: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf-8")) as { name?: string };
  return manifest.name || basename(pluginDir);
}

async function pluginRemove(cwd: string, flags: { args?: string[] }): Promise<void> {
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: "remove",
        cwd,
        details: ["Usage: setup plugin remove <name>"],
      })
    );
    return;
  }

  const pluginDir = join(cwd, ".setupr", "plugins", name);
  try {
    await rm(pluginDir, { recursive: true, force: true });
  } catch {}

  const config = await loadConfig();
  config.plugins = (config.plugins || []).filter((p) => p.name !== name);
  await saveConfig(config);

  console.log(chalk.green(`✓ Removed plugin: ${name}`));
}

async function pluginList(_cwd: string): Promise<void> {
  const config = await loadConfig();
  const plugins = config.plugins || [];

  if (plugins.length === 0) {
    console.log(chalk.dim("No plugins installed."));
    console.log(chalk.dim("Run 'setupr plugin install <name>' to add one, or 'setupr plugin create <name>' to build one."));
    return;
  }

  console.log(chalk.blue.bold("\n  Installed Plugins\n"));
  for (const p of plugins) {
    const status = p.enabled ? chalk.green("●") : chalk.red("○");
    const source = chalk.dim(`(${p.source || "unknown"})`);
    console.log(`  ${status} ${chalk.white(p.name)} ${chalk.dim(p.version || "")} ${source}`);
  }
  console.log(chalk.dim(`\n  ${plugins.length} plugin${plugins.length === 1 ? "" : "s"} installed\n`));
}

async function pluginInfo(cwd: string, flags: { args?: string[] }): Promise<void> {
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: "info",
        cwd,
        details: ["Usage: setup plugin info <name>"],
      })
    );
    return;
  }

  const pluginDir = join(cwd, ".setupr", "plugins", name);
  try {
    const manifestPath = join(pluginDir, "package.json");
    const raw = await readFile(manifestPath, "utf-8");
    const manifest: PluginManifest = JSON.parse(raw);

    console.log(chalk.blue.bold(`\n  Plugin: ${manifest.name}\n`));
    console.log(`  Version:     ${chalk.white(manifest.version)}`);
    console.log(`  Description: ${chalk.white(manifest.description || "none")}`);
    if (manifest.author) console.log(`  Author:      ${chalk.white(manifest.author)}`);
    if (manifest.hooks) console.log(`  Hooks:       ${chalk.dim(manifest.hooks.join(", "))}`);
    if (manifest.commands) console.log(`  Commands:    ${chalk.dim(manifest.commands.join(", "))}`);
    console.log("");
  } catch {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: "info",
        cwd,
        details: [`Plugin '${name}' not found or missing package.json.`],
      })
    );
  }
}

async function pluginToggle(cwd: string, flags: { args?: string[] }, enable: boolean): Promise<void> {
  const name = flags.args?.[0];
  if (!name) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: enable ? "enable" : "disable",
        cwd,
        details: [`Usage: setup plugin ${enable ? "enable" : "disable"} <name>`],
      })
    );
    return;
  }

  const config = await loadConfig();
  const plugin = (config.plugins || []).find((p) => p.name === name);
  if (!plugin) {
    printPlainError(
      createSetuprError({
        code: "PLUGIN_NOT_FOUND",
        command: "plugin",
        subcommand: enable ? "enable" : "disable",
        cwd,
        details: [`Plugin '${name}' is not installed.`],
      })
    );
    return;
  }

  plugin.enabled = enable;
  await saveConfig(config);
  console.log(chalk.green(`✓ Plugin '${name}' ${enable ? "enabled" : "disabled"}`));
}

async function pluginCreate(cwd: string, flags: { args?: string[]; force?: boolean }): Promise<void> {
  const rawName = flags.args?.[0];
  if (!rawName) {
    printPlainError(createSetuprError({
      code: "PLUGIN_INVALID",
      command: "plugin",
      subcommand: "create",
      cwd,
      details: ["Usage: setupr plugin create <name>"],
      nextSteps: ["Use a package-style name such as setupr-plugin-team or @scope/setupr-plugin-team."],
    }));
    return;
  }

  const packageName = normalizePluginPackageName(rawName);
  const folderName = packageName.replace(/^@/, "").replace(/[\\/]/g, "__");
  const targetDir = resolve(cwd, flags.args?.[1] || folderName);
  if (existsSync(targetDir) && !flags.force) {
    printPlainError(createSetuprError({
      code: "PLUGIN_INVALID",
      command: "plugin",
      subcommand: "create",
      cwd,
      details: [`Target already exists: ${targetDir}`],
      nextSteps: ["Choose another folder or rerun with --force if you want Setupr to write into it."],
    }));
    return;
  }

  await mkdir(join(targetDir, "src"), { recursive: true });
  await writeFile(join(targetDir, "package.json"), JSON.stringify({
    name: packageName,
    version: "0.1.0",
    description: "Setupr plugin",
    type: "module",
    main: "dist/index.js",
    exports: "./dist/index.js",
    files: ["dist", "README.md"],
    scripts: {
      build: "tsc -p tsconfig.json",
      validate: "setupr plugin validate .",
    },
    keywords: ["setupr", "setupr-plugin"],
    peerDependencies: {
      [SETUPR_PACKAGE_NAME]: `^${SETUPR_VERSION.split(".")[0]}.0.0`,
    },
    devDependencies: {
      typescript: "^5.7.0",
    },
    setupr: {
      apiVersion: "1",
      commands: ["example"],
      scanners: [],
      planners: [],
      doctorChecks: [],
      fixers: [],
      panels: [],
    },
  }, null, 2) + "\n");
  await writeFile(join(targetDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      declaration: true,
      outDir: "dist",
      strict: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
  }, null, 2) + "\n");
  await writeFile(join(targetDir, ".gitignore"), "node_modules\ndist\n.env\n.DS_Store\n");
  await writeFile(join(targetDir, "src", "index.ts"), pluginStarterSource(packageName));
  await writeFile(join(targetDir, "README.md"), pluginReadme(packageName));

  console.log(chalk.green(`✓ Created Setupr plugin project: ${basename(targetDir)}`));
  console.log(chalk.dim(`  Package: ${packageName}`));
  console.log(chalk.dim(`  Path: ${targetDir}`));
  console.log(chalk.dim("  Next: npm install && npm run build && setupr plugin validate ."));
}

async function pluginValidate(cwd: string, flags: { args?: string[] }): Promise<void> {
  const target = resolve(cwd, flags.args?.[0] || ".");
  const manifestPath = join(target, "package.json");
  const issues: string[] = [];
  let manifest: PluginManifest | undefined;

  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as PluginManifest;
  } catch (err) {
    printPlainError(createSetuprError({
      code: "PLUGIN_INVALID",
      command: "plugin",
      subcommand: "validate",
      cwd,
      details: [`Could not read ${manifestPath}.`, err instanceof Error ? err.message : String(err)],
      nextSteps: ["Run this inside a plugin folder or pass the plugin path."],
    }));
    return;
  }

  if (!manifest.name) issues.push("package.json must include name.");
  if (!manifest.version) issues.push("package.json must include version.");
  if (!manifest.main && !("exports" in manifest)) issues.push("package.json should expose a built entrypoint with main or exports.");
  if (!manifest.name?.includes("setupr-plugin") && !manifest.keywords?.includes("setupr-plugin")) {
    issues.push("Plugin packages should include setupr-plugin in the name or keywords.");
  }
  const setuprBlock = manifest.setupr;
  if (!setuprBlock) issues.push("package.json should include a setupr block with apiVersion and extension metadata.");
  if (setuprBlock && setuprBlock.apiVersion !== "1") issues.push("setupr.apiVersion must be \"1\".");
  if (setuprBlock && !Array.isArray(setuprBlock.commands) && !Array.isArray(setuprBlock.scanners) && !Array.isArray(setuprBlock.panels) && !Array.isArray(setuprBlock.planners) && !Array.isArray(setuprBlock.doctorChecks) && !Array.isArray(setuprBlock.fixers)) {
    issues.push("setupr block should define commands, scanners, planners, doctorChecks, fixers, or panels arrays.");
  }

  const mainPath = typeof manifest.main === "string" ? join(target, manifest.main) : undefined;
  if (mainPath && !existsSync(mainPath)) {
    const sourceFallback = join(target, "src", "index.ts");
    if (!existsSync(sourceFallback)) issues.push(`Entrypoint is missing: ${manifest.main}`);
  }

  console.log(chalk.blue.bold("\n  Plugin Validation\n"));
  console.log(`  Path:    ${chalk.white(target)}`);
  console.log(`  Package: ${chalk.white(manifest.name || "unknown")}`);
  if (issues.length === 0) {
    console.log(chalk.green("  ✓ Manifest looks valid for Setupr plugin development."));
    console.log("");
    return;
  }
  for (const issue of issues) console.log(`  ${chalk.yellow("•")} ${issue}`);
  console.log(chalk.dim("\n  Setupr can still inspect this folder, but installation/runtime loading may fail until these are fixed.\n"));
}

async function pluginDoctor(cwd: string): Promise<void> {
  const config = await loadConfig();
  const projectPluginDir = join(cwd, ".setupr", "plugins");
  const runtime = await loadEnabledPlugins(cwd);
  console.log(chalk.blue.bold("\n  Plugin Developer Environment\n"));
  console.log(`  Project plugin dir: ${chalk.white(projectPluginDir)}`);
  console.log(`  Installed plugins:  ${chalk.white(String(config.plugins.length))}`);
  console.log(`  Enabled plugins:    ${chalk.white(String(config.plugins.filter((plugin) => plugin.enabled).length))}`);
  console.log(`  Scaffold command:   ${chalk.dim("setupr plugin create <name>")}`);
  console.log(`  Validate command:   ${chalk.dim("setupr plugin validate <path>")}`);
  console.log(`  Extension points:   ${chalk.dim("commands, scanners, planners, doctorChecks, fixers, panels")}`);
  if (runtime.diagnostics.length) {
    console.log(chalk.yellow("\n  Runtime Loading"));
    for (const diagnostic of runtime.diagnostics) {
      const marker = diagnostic.status === "loaded" ? chalk.green("✓") : diagnostic.status === "skipped" ? chalk.yellow("△") : chalk.red("✗");
      console.log(`  ${marker} ${chalk.white(diagnostic.name)} ${chalk.dim(diagnostic.message)}`);
    }
  }
  console.log("");
}

function normalizePluginPackageName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("@")) return trimmed.includes("setupr-plugin") ? trimmed : `${trimmed.replace(/\/$/, "")}/setupr-plugin`;
  return trimmed.startsWith("setupr-plugin-") ? trimmed : `setupr-plugin-${trimmed.replace(/^plugin-/, "")}`;
}

function pluginStarterSource(packageName: string): string {
  return `/** @type {import("setupr/dist/plugins/api.js").SetuprPlugin} */
export const plugin = {
  name: "${packageName}",
  apiVersion: "1",
  scanners: [
    {
      name: "example-scan",
      scan(context) {
        context.log("Scanning from ${packageName}");
        return { exampleSignal: true };
      },
    },
  ],
  planners: [
    {
      name: "example-plan",
      plan(_context, steps) {
        return steps;
      },
    },
  ],
  doctorChecks: [
    {
      name: "example-check",
      async check() {
        return { status: "pass", message: "Example plugin check passed." };
      },
    },
  ],
  fixers: [
    {
      name: "example-fixer",
      canFix() {
        return false;
      },
      async fix() {},
    },
  ],
  panels: [
    {
      id: "example-panel",
      title: "Example",
      renderText() {
        return "Plugin panel content";
      },
    },
  ],
  commands: [
    {
      name: "example",
      summary: "Example plugin command.",
      async run(context) {
        context.log("Hello from ${packageName}");
      },
    },
  ],
};

export default plugin;
`;
}

function pluginReadme(packageName: string): string {
  return `# ${packageName}

Setupr plugin starter.

## Commands

- \`npm install\`
- \`npm run build\`
- \`setupr plugin validate .\`

## Shape

Plugins expose a default \`plugin\` object with extension metadata. Setupr validates the package manifest before install/runtime loading so bad plugins fail with clear errors.
`;
}
