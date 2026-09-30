import chalk from "chalk";
import { loadConfig, saveConfig } from "../state/config.js";
import { SETUPR_PACKAGE_NAME, SETUPR_VERSION } from "../version.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface VersionInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

export async function checkForUpdates(silent = false): Promise<VersionInfo | null> {
  const config = await loadConfig();

  // Respect autoUpdate preference
  if (!config.preferences?.autoUpdate && silent) {
    return null;
  }

  // Rate limit checks to once per day
  const lastCheck = config.lastUpdateCheck || 0;
  if (silent && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
    return null;
  }

  try {
    const currentVersion = await getCurrentVersion();
    const latestVersion = await fetchLatestVersion();
    if (!latestVersion) {
      if (!silent) console.log(chalk.dim("Could not check for updates."));
      return null;
    }

    // Update last check timestamp
    config.lastUpdateCheck = Date.now();
    await saveConfig(config);

    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    if (hasUpdate && !silent) {
      printUpdateNotice(currentVersion, latestVersion);
    }

    return { current: currentVersion, latest: latestVersion, hasUpdate };
  } catch {
    if (!silent) {
      console.log(chalk.dim("Could not check for updates."));
    }
    return null;
  }
}

export async function getCurrentVersion(): Promise<string> {
  return SETUPR_VERSION;
}

export async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(SETUPR_PACKAGE_NAME)}/latest`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function printUpdateNotice(current: string, latest: string): void {
  console.log("");
  console.log(chalk.yellow(`  Update available: ${current} → ${latest}`));
  console.log(chalk.dim(`  Run: npm install -g ${SETUPR_PACKAGE_NAME}`));
  console.log("");
}
