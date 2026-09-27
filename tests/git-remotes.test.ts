import { execFileSync } from "child_process";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdGithub } from "../src/commands/plain/product.js";
import { cmdGit } from "../src/commands/plain/git.js";
import * as executor from "../src/executor/index.js";
import { parseGitHubRepo, readGitRemotes, redactGitOutput, redactGitRemoteUrl, selectGitRemote } from "../src/util/gitRemote.js";

let cwd: string;
let logs: string[];
let previousExitCode: typeof process.exitCode;
const ok = { stdout: "", stderr: "", exitCode: 0 };

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function remote(name: string, url: string): void {
  git("remote", "add", "--", name, url);
}

async function github(name?: string) {
  await cmdGithub("status", cwd, { json: true, ...(name === undefined ? {} : { remote: name }) });
  return JSON.parse(logs.join("\n"));
}

function commit(): void {
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
}

function track(name = "origin", branch = "main"): void {
  commit();
  git("update-ref", `refs/remotes/${name}/${branch}`, "HEAD");
  git("config", "branch.main.remote", name);
  git("config", "branch.main.merge", `refs/heads/${branch}`);
}

function stubNetwork(options: { gh?: boolean; pull?: typeof ok; push?: typeof ok; ghResult?: typeof ok } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = executor.runCommand;
  const runArgs = executor.runCommandArgs;
  const networkResult = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (command === "gh") return args[0] === "--version"
      ? { ...ok, exitCode: options.gh ? 0 : 127 }
      : options.ghResult || ok;
    return args[0] === "pull" ? options.pull || ok : options.push || ok;
  };
  vi.spyOn(executor, "runCommand").mockImplementation((command, ...args) => {
    // Catch the old shell-based paths too, so regression tests cannot reach the network.
    if (/^(?:git (?:push|pull|fetch)|gh)(?: |$)/.test(command)) {
      const [program, ...argv] = command.split(" ");
      return Promise.resolve(networkResult(program, argv));
    }
    if (!["git --version", "git rev-parse --is-inside-work-tree", "git branch --show-current"].includes(command)) {
      throw new Error(`Unexpected shell command in remote fixture: ${command}`);
    }
    return run(command, ...args);
  });
  vi.spyOn(executor, "runCommandArgs").mockImplementation((command, args, ...rest) => {
    if (command === "gh" || (command === "git" && ["push", "pull", "fetch"].includes(args[0]))) {
      return Promise.resolve(networkResult(command, args));
    }
    if (command !== "git" || !["branch", "config", "rev-parse", "log", "diff", "rev-list", "symbolic-ref"].includes(args[0])) {
      throw new Error(`Unexpected command in remote fixture: ${command} ${args.join(" ")}`);
    }
    return runArgs(command, args, ...rest);
  });
  return calls;
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "setupr git-remotes-"));
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  // Even a regression must not contact a remote or inherit host Git configuration.
  vi.stubEnv("GIT_ALLOW_PROTOCOL", "");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(cwd, "absent-gitconfig"));
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  git("init", "-b", "main");
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => logs.push(values.join(" ")));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = previousExitCode;
  await rm(cwd, { recursive: true, force: true });
});

describe("GitHub remote selection", () => {
  it("keeps a fork origin by default and permits explicitly selecting upstream", async () => {
    remote("origin", "https://github.com/contributor/project.git");
    remote("upstream", "git@github.com:maintainer/project.git");
    expect((await github()).repo).toBe("contributor/project");
    logs.length = 0;
    expect((await github("upstream")).repo).toBe("maintainer/project");
  });

  it("finds a non-origin GitHub remote", async () => {
    remote("company", "ssh://git@github.com/team/project.git");
    expect(await github()).toMatchObject({ remoteName: "company", repo: "team/project" });
  });

  it("finds GitHub upstream when origin is GitLab", async () => {
    remote("origin", "https://gitlab.com/team/project.git");
    remote("upstream", "https://github.com/team/project.git");
    expect(await github()).toMatchObject({ remoteName: "upstream", repo: "team/project" });
  });

  it("parses dotted repository names and SSH URL ports", async () => {
    remote("origin", "ssh://git@github.com:22/team/project.web.git");
    expect((await github()).url).toBe("https://github.com/team/project.web");
  });

  it("does not mistake a lookalike host for GitHub", async () => {
    remote("origin", "https://notgithub.com/team/project.git");
    expect((await github()).repo).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("redacts credentials from the JSON remote field", async () => {
    remote("origin", "https://fixture-user:fixture-secret@github.com/team/project.git?token=fixture-token#fixture-fragment");
    expect((await github()).repo).toBe("team/project");
    expect(logs.join("\n")).not.toMatch(/fixture-(user|secret|token|fragment)/);
  });

  it("does not fall back when an explicit remote is absent", async () => {
    remote("origin", "https://github.com/team/project.git");
    expect((await github("missing")).repo).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("signals missing remotes in JSON mode", async () => {
    expect((await github()).repo).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("rejects an explicitly selected GitLab remote without falling back to GitHub", async () => {
    remote("origin", "https://gitlab.com/team/project.git");
    remote("upstream", "https://github.com/team/project.git");
    expect((await github("origin")).repo).toBeNull();
    expect(process.exitCode).toBe(1);
  });

  it("prefers upstream over other GitHub remotes, then uses stable name ordering", async () => {
    remote("zeta", "git@github.com:zeta/project.git");
    remote("alpha", "git@github.com:alpha/project.git");
    remote("upstream", "git@github.com:maintainer/project.git");
    expect((await github()).remoteName).toBe("upstream");
    git("remote", "remove", "upstream");
    logs.length = 0;
    expect((await github()).remoteName).toBe("alpha");
  });

  it("handles an invalid origin URL without discarding a valid upstream", async () => {
    remote("origin", "https://github.com/not/a/repository");
    remote("upstream", "https://github.com/team/project.git");
    expect((await github()).remoteName).toBe("upstream");
  });

  it("uses the first fetch URL rather than concatenating multiple URLs", async () => {
    remote("origin", "https://github.com/team/project.git");
    git("config", "--add", "remote.origin.url", "https://github.com/team/mirror.git");
    expect((await github()).repo).toBe("team/project");
  });

  it("resolves Git insteadOf URL aliases without fetching", async () => {
    git("config", "url.https://fixture-user:fixture-secret@github.com/.insteadOf", "gh:");
    remote("origin", "gh:team/project.web.git");
    expect(await github()).toMatchObject({ repo: "team/project.web", remote: "https://github.com/team/project.web.git" });
    expect(logs.join("\n")).not.toContain("fixture-secret");
  });

  it("treats option-looking and shell metacharacter remote selectors as data", async () => {
    const name = "fork;$(touch${IFS}REMOTE_INJECTION)";
    remote(name, "git@github.com:team/project.git");
    expect((await github(name)).remoteName).toBe(name);
    expect(git("status", "--porcelain")).toBe("");
    logs.length = 0;
    expect((await github("--all")).repo).toBeNull();
  });

  it("reports absence outside a repository without leaking Git diagnostics", async () => {
    await rm(join(cwd, ".git"), { recursive: true, force: true });
    expect(await github()).toMatchObject({ repo: null, remoteName: null });
    expect(process.exitCode).toBe(1);
  });

  it("shows the selected remote in plain output without credentials", async () => {
    remote("company", "https://fixture-user:fixture-secret@github.com/team/project.web.git");
    await cmdGithub("status", cwd, { remote: "company" });
    expect(logs.join("\n")).toContain("Remote:  company");
    expect(logs.join("\n")).toContain("https://github.com/team/project.web/actions");
    expect(logs.join("\n")).not.toContain("fixture-secret");
  });

  it("returns only redacted URLs for generic status/context consumers", async () => {
    remote("origin", "https://fixture-user:fixture-secret@gitlab.com/team/project.git?private=fixture-token");
    remote("upstream", "git@github.com:team/project.git");
    const remotes = await readGitRemotes(cwd);
    expect(selectGitRemote(remotes)?.url).toBe("https://gitlab.com/team/project.git");
    expect(selectGitRemote(remotes, undefined, { githubOnly: true })?.name).toBe("upstream");
    expect(JSON.stringify(remotes)).not.toMatch(/fixture-(user|secret|token)/);
  });

  it("resolves pushInsteadOf independently from the fetch URL", async () => {
    remote("origin", "https://github.com/team/project.git");
    git("config", "url.https://fixture-user:fixture-secret@github.com/fork/.pushInsteadOf", "https://github.com/team/");
    expect(selectGitRemote(await readGitRemotes(cwd))?.githubRepo).toBe("team/project");
    const push = selectGitRemote(await readGitRemotes(cwd, { push: true }));
    expect(push).toMatchObject({ url: "https://github.com/fork/project.git", githubRepo: "fork/project" });
    expect(JSON.stringify(push)).not.toContain("fixture-secret");
  });
});

describe("remote URL parsing and redaction", () => {
  it.each([
    "https://github.com/team/project.web.git",
    "http://github.com/team/project.web.git/",
    "git@github.com:team/project.web.git",
    "github.com:/team/project.web",
    "ssh://git@github.com:22/team/project.web.git",
    "ssh://git@ssh.github.com:443/team/project.web.git",
    "git://github.com/team/project.web.git",
    "https://GITHUB.COM/team/project.web.git?token=fixture-token#fragment",
  ])("parses %s", (url) => {
    expect(parseGitHubRepo(url)).toBe("team/project.web");
  });

  it.each([
    "", "not a URL", "/tmp/github.com/team/project.git", "https://notgithub.com/team/project.git",
    "https://github.com.evil.example/team/project.git", "https://github.com@evil.example/team/project.git",
    "https://example.com/github.com/team/project.git", "file:///github.com/team/project.git",
    "https://github.com/team/project/tree/main", "https://github.com/team/",
    "https://github.com/team/../project/other", "https://github.com/team/%2e%2e/project/other",
    "https://github.com/team/project%2fother", "https://github.com/team/project\\other",
    "https://github.com/team/project.git\nsecret", "https://github.com:invalid/team/project.git",
  ])("rejects %s", (url) => {
    expect(parseGitHubRepo(url)).toBeNull();
  });

  it.each([
    "https://fixture-user:fixture-secret@github.com/team/project.git?auth=fixture-token#fixture-fragment",
    "https://fixture-secret@github.com/team/project.git",
    "ssh://fixture-user:fixture-secret@github.com/team/project.git",
    "fixture-secret@github.com:team/project.git",
    "https://fixture-user:fixture-secret@github.com:bad/team/project.git",
    "ext::helper fixture-secret",
    "ext::helper https://fixture-user:fixture-secret@github.com/team/project.git",
    "custom:https://fixture-user:fixture-secret@github.com/team/project.git",
  ])("redacts credentials in %s", (url) => {
    expect(redactGitRemoteUrl(url)).not.toMatch(/fixture-(user|secret|token|fragment)/);
    expect(redactGitOutput(`fatal: failed to access '${url}'`)).not.toMatch(/fixture-(user|secret|token|fragment)/);
  });

  it("redacts a username echoed by SSH authentication failures", () => {
    expect(redactGitOutput("fixture-secret@github.com: Permission denied (publickey).")).toBe("github.com: Permission denied (publickey).");
  });

  it("preserves a credential-free IPv6 remote", () => {
    expect(redactGitRemoteUrl("https://fixture-user:fixture-secret@[::1]/project.git")).toBe("https://[::1]/project.git");
  });
});

describe("remote mutations", () => {
  it.each(["list", "status", "unsupported"])("does not push for PR %s without gh installed", async (action) => {
    remote("origin", "https://github.com/team/project.git");
    const calls = stubNetwork();
    await cmdGit("pr", cwd, { args: [action] });
    expect(calls.some(({ command }) => command === "git")).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it.each(["create", "list", "status"])("passes an explicit GitHub repository to gh pr %s", async (action) => {
    remote("origin", "https://github.com/fork/project.git");
    remote("upstream", "git@github.com:team/project.web.git");
    const calls = stubNetwork({ gh: true });
    await cmdGit("pr", cwd, { args: [action], remote: "upstream" });
    expect(calls).toContainEqual({ command: "gh", args: ["pr", action, "--repo", "team/project.web", ...(action === "create" ? ["--fill"] : [])] });
    expect(calls.some(({ command }) => command === "git")).toBe(false);
  });

  it("preserves gh's default fork/upstream selection when --remote is not supplied", async () => {
    remote("origin", "https://github.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    const calls = stubNetwork({ gh: true });
    await cmdGit("pr", cwd, { args: ["create"] });
    expect(calls).toContainEqual({ command: "gh", args: ["pr", "create", "--fill"] });
  });

  it("uses the actual push URL for the fallback PR link", async () => {
    remote("origin", "https://github.com/team/project.git");
    git("remote", "set-url", "--push", "origin", "https://fixture-user:fixture-secret@github.com/fork/project.web.git");
    git("checkout", "-b", "feature/example#section");
    const calls = stubNetwork();
    await cmdGit("pr", cwd, { args: ["create"] });
    expect(calls).toContainEqual({ command: "git", args: ["push", "-u", "--", "origin", "HEAD:refs/heads/feature/example#section"] });
    expect(logs.join("\n")).toContain("https://github.com/fork/project.web/compare/feature%2Fexample%23section");
    expect(logs.join("\n")).not.toContain("fixture-secret");
  });

  it("refuses to auto-push upstream when origin is GitLab", async () => {
    remote("origin", "https://gitlab.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    const calls = stubNetwork();
    await cmdGit("pr", cwd, {});
    expect(calls.some(({ command }) => command === "git")).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it.each(["company;literal", "-company"])("can explicitly push a non-origin GitHub remote named %s", async (name) => {
    remote("origin", "https://gitlab.com/fork/project.git");
    remote(name, "git@github.com:team/project.git");
    const calls = stubNetwork();
    await cmdGit("pr", cwd, { remote: name });
    expect(calls).toContainEqual({ command: "git", args: ["push", "-u", "--", name, "HEAD:refs/heads/main"] });
  });

  it("refuses multiple push URLs before making a PR fallback push", async () => {
    remote("origin", "https://github.com/team/project.git");
    git("config", "--add", "remote.origin.pushurl", "https://github.com/fork/project.git");
    git("config", "--add", "remote.origin.pushurl", "https://github.com/other/project.git");
    const calls = stubNetwork();
    await cmdGit("pr", cwd, {});
    expect(calls.some(({ command }) => command === "git")).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  it("does not call gh or push when the explicit remote is missing", async () => {
    remote("origin", "https://github.com/team/project.git");
    const calls = stubNetwork({ gh: true });
    await cmdGit("pr", cwd, { remote: "--all" });
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it("reports gh failures instead of claiming no open PRs", async () => {
    const calls = stubNetwork({ gh: true, ghResult: { ...ok, exitCode: 1, stderr: "authentication failed" } });
    await cmdGit("pr", cwd, { args: ["list"] });
    expect(calls).toHaveLength(2);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).not.toContain("No open PRs");
  });

  it.each(["pr", "sync"])("redacts failed %s push diagnostics and never prints success", async (sub) => {
    remote("origin", "https://github.com/team/project.git");
    const calls = stubNetwork({ push: { ...ok, exitCode: 1, stderr: "fatal: https://fixture-user:fixture-secret@github.com/team/project.git?token=fixture-token refused" } });
    await cmdGit(sub, cwd, {});
    expect(calls.some(({ args }) => args[0] === "push")).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).not.toMatch(/fixture-(user|secret|token)|Synced|Create PR at/);
  });

  it("does not push after a failed pull", async () => {
    remote("origin", "https://github.com/team/project.git");
    track();
    const calls = stubNetwork({ pull: { ...ok, exitCode: 1, stderr: "Network unavailable" } });
    await cmdGit("sync", cwd, {});
    expect(calls).toEqual([{ command: "git", args: ["pull", "--rebase"] }]);
    expect(process.exitCode).toBe(1);
    expect(logs.join("\n")).not.toContain("Synced");
  });

  it("preserves configured tracking and push defaults for an established branch", async () => {
    remote("origin", "https://github.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    track("upstream", "develop");
    git("config", "remote.pushDefault", "origin");
    const calls = stubNetwork();
    await cmdGit("sync", cwd, {});
    expect(calls).toEqual([{ command: "git", args: ["pull", "--rebase"] }, { command: "git", args: ["push"] }]);
    expect(logs.join("\n")).toContain("Synced");
  });

  it("preserves configured tracking before a remote-tracking ref has been fetched", async () => {
    remote("origin", "https://github.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    commit();
    git("config", "branch.main.remote", "upstream");
    git("config", "branch.main.merge", "refs/heads/develop");
    const calls = stubNetwork();
    await cmdGit("sync", cwd, {});
    expect(calls).toEqual([{ command: "git", args: ["pull", "--rebase"] }, { command: "git", args: ["push"] }]);
  });

  it("uses an explicit sync remote for both pull and push", async () => {
    remote("origin", "https://github.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    track();
    const calls = stubNetwork();
    await cmdGit("sync", cwd, { remote: "upstream" });
    expect(calls).toEqual([
      { command: "git", args: ["pull", "--rebase", "--", "upstream", "main"] },
      { command: "git", args: ["push", "-u", "--", "upstream", "HEAD:refs/heads/main"] },
    ]);
  });

  it("uses a sole non-origin remote when there is no tracking branch", async () => {
    remote("company", "https://gitlab.com/team/project.git");
    const calls = stubNetwork();
    await cmdGit("sync", cwd, {});
    expect(calls).toEqual([{ command: "git", args: ["push", "-u", "--", "company", "HEAD:refs/heads/main"] }]);
  });

  it.each(["remote.pushDefault", "branch.main.pushRemote"])("honors %s when choosing an initial push remote", async (key) => {
    remote("origin", "https://github.com/team/project.git");
    remote("fork", "https://github.com/fork/project.git");
    git("config", key, "fork");
    const calls = stubNetwork();
    await cmdGit("sync", cwd, {});
    expect(calls).toEqual([{ command: "git", args: ["push", "-u", "--", "fork", "HEAD:refs/heads/main"] }]);
  });

  it("requires an explicit choice for multiple non-origin push remotes", async () => {
    remote("fork", "https://github.com/fork/project.git");
    remote("upstream", "https://github.com/team/project.git");
    const calls = stubNetwork();
    await cmdGit("sync", cwd, {});
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it.each([undefined, "missing", "--all"])("never attempts network operations without a valid sync remote (%s)", async (name) => {
    const calls = stubNetwork();
    await cmdGit("sync", cwd, { remote: name });
    expect(calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });

  it.each(["pr", "sync"])("does not attempt a %s push from detached HEAD", async (sub) => {
    remote("origin", "https://github.com/team/project.git");
    commit();
    git("checkout", "--detach", "HEAD");
    const calls = stubNetwork();
    await cmdGit(sub, cwd, {});
    expect(calls.some(({ command }) => command === "git")).toBe(false);
    expect(logs.join("\n")).toContain("detached HEAD");
    expect(process.exitCode).toBe(1);
  });
});

describe("remote-only comparison bases", () => {
  it("uses a non-origin remote base without interpreting its name as shell syntax", async () => {
    const name = "partner;$(touch${IFS}REMOTE_INJECTION)";
    remote(name, "https://github.com/team/project.git");
    commit();
    git("update-ref", `refs/remotes/${name}/main`, "HEAD");
    git("branch", "-m", "feature/demo");
    await cmdGit("pr-description", cwd, {});
    expect(logs.join("\n")).toContain(`Base: refs/remotes/${name}/main`);
    expect(git("status", "--porcelain")).toBe("");
  });

  it("honors a remote's local HEAD when its default branch has a custom name", async () => {
    remote("upstream", "https://github.com/team/project.git");
    commit();
    git("update-ref", "refs/remotes/upstream/integration", "HEAD");
    git("symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/integration");
    git("branch", "-m", "feature/demo");
    await cmdGit("branch-check", cwd, {});
    expect(logs.join("\n")).toContain("Compared with:  refs/remotes/upstream/integration (0 ahead, 0 behind)");
  });
});
