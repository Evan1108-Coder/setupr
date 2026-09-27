import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitRemote {
  name: string;
  /** Display-only URLs. Never use these redacted values for Git operations. */
  url: string;
  urls: string[];
  githubRepo: string | null;
}

export function parseGitHubRepo(remote: string): string | null {
  const value = remote.trim();
  if (!value || /[\s\\]/.test(value) || hasControlCharacters(value)) return null;
  let path: string;
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null;
      const host = url.hostname.toLowerCase();
      if (host !== "github.com" && !(url.protocol === "ssh:" && host === "ssh.github.com" && url.port === "443")) return null;
      // URL normalizes dot segments; reject them before trusting the parsed path.
      const rawPath = value.slice(value.indexOf("://") + 3).replace(/^[^/]+/, "").split(/[?#]/, 1)[0];
      if (rawPath.split("/").some((part) => /^(?:\.|%2e){1,2}$/i.test(part))) return null;
      path = url.pathname;
    } catch {
      return null;
    }
  } else {
    const scp = value.match(/^(?:[^/@:]+@)?github\.com:(\/?[^?#]+)$/i);
    if (!scp) return null;
    path = scp[1];
  }
  const parts = path.replace(/^\//, "").replace(/\/$/, "").split("/");
  if (parts.length !== 2) return null;
  const [owner, repository] = parts;
  const repo = repository.replace(/\.git$/, "");
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)) return null;
  if (!/^[a-z\d_.-]+$/i.test(repo) || repo === "." || repo === "..") return null;
  return `${owner}/${repo}`;
}

export function redactGitRemoteUrl(remote: string): string {
  const value = remote.trim();
  if (hasControlCharacters(value)) return "[invalid remote URL]";
  if (/^[a-z][a-z\d+.-]*::/i.test(value)) return "[unsupported remote URL]";
  if (value.includes("://")) {
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return "[invalid remote URL]";
    try {
      const url = new URL(value);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return "[invalid remote URL]";
    }
  }
  const scp = value.match(/^(?:[^/]*@)?([^/:]+):(.+)$/);
  if (scp) return `${scp[1]}:${scp[2].split(/[?#]/, 1)[0]}`;
  return value;
}

export function redactGitOutput(output: string): string {
  return output
    .replace(/\b[a-z][a-z\d+.-]*::[^\r\n]*/gi, "[unsupported remote URL]")
    .replace(/[a-z][a-z\d+.-]*:\/\/[^\s'"<>]+/gi, redactGitRemoteUrl)
    .replace(/[^\s'"<>/@]+@[^\s'"<>/:]+:[^\s'"<>]+/g, redactGitRemoteUrl)
    .replace(/[^\s'"<>/@]+@(?=[^\s'"<>/:]+:)/g, "");
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

/** Read local configuration only, including Git's insteadOf/pushInsteadOf expansion. */
export async function readGitRemotes(cwd: string, options: { push?: boolean } = {}): Promise<GitRemote[]> {
  const run = async (args: string[]) => {
    try {
      return (await execFileAsync("git", args, { cwd, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true })).stdout.trim();
    } catch {
      return "";
    }
  };
  const names = (await run(["remote"])).split("\n").filter(Boolean).sort((a, b) => {
    const rank = (name: string) => name === "origin" ? 0 : name === "upstream" ? 1 : 2;
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  const remotes: GitRemote[] = [];
  for (const name of names) {
    const urls = (await run(["remote", "get-url", ...(options.push ? ["--push"] : []), "--all", "--", name])).split("\n").filter(Boolean);
    if (!urls.length) continue;
    remotes.push({ name, url: redactGitRemoteUrl(urls[0]), urls: urls.map(redactGitRemoteUrl), githubRepo: parseGitHubRepo(urls[0]) });
  }
  return remotes;
}

/** Origin, then upstream, then other remotes. Explicit selection never falls back. */
export function selectGitRemote(remotes: GitRemote[], name?: string, options: { githubOnly?: boolean } = {}): GitRemote | null {
  return remotes.find((remote) => (name === undefined || remote.name === name) && (!options.githubOnly || remote.githubRepo !== null)) || null;
}
