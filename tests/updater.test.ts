import { afterEach, describe, expect, it, vi } from "vitest";
import packageInfo from "../package.json";
import { checkForUpdates, fetchLatestVersion, getCurrentVersion } from "../src/updater/index.js";

vi.mock("../src/state/config.js", () => ({
  loadConfig: vi.fn(async () => ({ preferences: { autoUpdate: true }, lastUpdateCheck: 0 })),
  saveConfig: vi.fn(),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Setupr update identity", () => {
  it("uses the packaged version rather than the current project's version", async () => {
    expect(await getCurrentVersion()).toBe(packageInfo.version);
  });

  it("checks the owned npm package", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: "9.8.7" }) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchLatestVersion()).toBe("9.8.7");
    expect(fetchMock.mock.calls[0][0]).toBe("https://registry.npmjs.org/%40evan-coder%2Fsetupr/latest");
  });

  it("does not invent a latest version when the registry is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchLatestVersion()).toBeNull();
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await checkForUpdates()).toBeNull();
    expect(output.mock.calls.map(([line]) => line).join("\n")).toContain("Could not check for updates.");
  });
});
