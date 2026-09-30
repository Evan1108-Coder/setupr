import React from "react";
import { render } from "ink";
import { App, type TUICommand } from "../tui/App.js";
import { createAppStore } from "../state/store.js";
import { scanProject } from "../scanner/index.js";
import { collectDashboardStatus, createDashboardFallbackStatus, type DashboardStatus } from "../status/collector.js";
import { createFullscreenOutput } from "./fullscreenOutput.js";

interface LaunchOptions {
  cleanMode?: "deps" | "share" | "all";
  force?: boolean;
  chatInitialMessage?: string;
  chatStartNew?: boolean;
  chatResume?: boolean;
}

export async function launchTUI(
  command: TUICommand,
  cwd: string,
  options?: LaunchOptions
): Promise<void> {
  process.stdout.write("\x1B[0m");

  const store = createAppStore(cwd);
  let dashboardStatus: DashboardStatus | undefined;

  if (command !== "setup" && command !== "dashboard" && command !== "status") {
    const scan = await scanProject(cwd);
    store.getState().setScan(scan);
  } else if (command === "dashboard" || command === "status") {
    dashboardStatus = await collectDashboardStatusForTui(cwd);
  }

  const output = createFullscreenOutput(process.stdout);
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(
      React.createElement(App, {
        command,
        cwd,
        store,
        cleanMode: options?.cleanMode || "deps",
        force: options?.force || false,
        dashboardStatus,
        chatInitialMessage: options?.chatInitialMessage,
        chatStartNew: options?.chatStartNew,
        chatResume: options?.chatResume,
      }),
      // Ink 5's debug mode supplies whole frames without clearTerminal or its
      // separate log-update cache. The adapter owns diffing and cursor movement.
      { exitOnCtrlC: true, stdout: output.stdout, debug: output.debug }
    );
    await instance.waitUntilExit();
  } finally {
    try {
      instance?.unmount();
    } finally {
      output.dispose();
    }
  }
}

async function collectDashboardStatusForTui(cwd: string): Promise<DashboardStatus> {
  const timeout = new Promise<DashboardStatus>((resolve) => {
    setTimeout(() => resolve(createDashboardFallbackStatus(cwd, "Status probes timed out before TUI render.")), 2500);
  });
  return Promise.race([collectDashboardStatus(cwd), timeout]);
}
