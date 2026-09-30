import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  render: vi.fn(),
  dispose: vi.fn(),
  unmount: vi.fn(),
  waitUntilExit: vi.fn(),
}));
vi.mock("ink", () => ({ render: mocks.render }));
vi.mock("../src/tui/App.js", () => ({ App: () => null }));
vi.mock("../src/state/store.js", () => ({ createAppStore: () => ({}) }));
vi.mock("../src/scanner/index.js", () => ({ scanProject: vi.fn() }));
vi.mock("../src/status/collector.js", () => ({
  collectDashboardStatus: vi.fn(), createDashboardFallbackStatus: vi.fn(),
}));
vi.mock("../src/cli/fullscreenOutput.js", () => ({
  createFullscreenOutput: () => ({ stdout: process.stdout, debug: true, dispose: mocks.dispose }),
}));

import { launchTUI } from "../src/cli/launcher.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.unmount.mockReset();
  mocks.waitUntilExit.mockReset().mockResolvedValue(undefined);
  mocks.render.mockReset().mockReturnValue({
    waitUntilExit: mocks.waitUntilExit, unmount: mocks.unmount,
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("fullscreen launcher cleanup", () => {
  it("selects complete-frame output and disposes after normal Ink exit", async () => {
    await launchTUI("setup", "/tmp/setupr-fullscreen-test");
    expect(mocks.render.mock.calls[0][1]).toEqual({
      exitOnCtrlC: true, stdout: process.stdout, debug: true,
    });
    expect(mocks.unmount).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.unmount.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispose.mock.invocationCallOrder[0]);
  });

  it("disposes even when render throws before returning an instance", async () => {
    mocks.render.mockImplementation(() => { throw new Error("render failed"); });
    await expect(launchTUI("setup", "/tmp/setupr-fullscreen-test")).rejects.toThrow("render failed");
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.unmount).not.toHaveBeenCalled();
  });

  it("unmounts and disposes after rejected Ink exit", async () => {
    mocks.waitUntilExit.mockRejectedValue(new Error("Ink exit failed"));
    await expect(launchTUI("setup", "/tmp/setupr-fullscreen-test")).rejects.toThrow("Ink exit failed");
    expect(mocks.unmount).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it("still restores output when unmount itself fails", async () => {
    mocks.unmount.mockImplementation(() => { throw new Error("unmount failed"); });
    await expect(launchTUI("setup", "/tmp/setupr-fullscreen-test")).rejects.toThrow("unmount failed");
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
