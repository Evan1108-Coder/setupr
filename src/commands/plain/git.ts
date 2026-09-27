import chalk from "chalk";
import { runCommand, runCommandArgs } from "../../executor/index.js";
import { createSetuprError, printPlainError } from "../../errors/index.js";
import { scanProject } from "../../scanner/index.js";
import { loadConfig } from "../../state/config.js";
import { readGitRemotes, redactGitOutput, selectGitRemote, type GitRemote } from "../../util/gitRemote.js";

interface GitFlags {
  force?: boolean;
  args?: string[];
  message?: string;
  branch?: string;
  remote?: string;
  [key: string]: unknown;
}

export async function cmdGit(sub: string | undefined, cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitAvailable(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_INSTALLED", command: "git", cwd }));
    return;
  }

  switch (sub) {
    case "init": return gitInit(cwd, flags);
    case "hooks": return gitHooks(cwd, flags);
    case "flow": return gitFlow(cwd, flags);
    case "commit-message": return gitCommitMessage(cwd);
    case "commit": return gitCommit(cwd, flags);
    case "pr-description": return gitPRDescription(cwd);
    case "branch-check": return gitBranchCheck(cwd);
    case "conflicts": return gitConflicts(cwd);
    case "branch": return gitBranch(cwd, flags);
    case "pr": return gitPR(cwd, flags);
    case "stash": return gitStash(cwd, flags);
    case "rebase": return gitRebase(cwd, flags);
    case "tag": return gitTag(cwd, flags);
    case "release": return gitRelease(cwd, flags);
    case "status": return gitStatus(cwd);
    case "log": return gitLog(cwd);
    case "sync": return gitSync(cwd, flags);
    case "clean": return gitClean(cwd, flags);
    case "ignore": return gitIgnore(cwd, flags);
    case "changelog": return gitChangelog(cwd, flags);
    case "blame": return gitBlame(cwd, flags);
    case "cherry-pick": return gitCherryPick(cwd, flags);
    case "worktree": return gitWorktree(cwd, flags);
    case "bisect": return gitBisect(cwd, flags);
    case "contributors": return gitContributors(cwd);
    case "undo": return gitUndo(cwd, flags);
    default:
      printPlainError(createSetuprError({
        code: "UNKNOWN_SUBCOMMAND",
        command: "git",
        subcommand: sub,
        cwd,
        details: ["Valid: init, hooks, flow, commit-message, commit, pr-description, branch-check, conflicts, branch, pr, stash, rebase, tag, release, status, log, sync, clean, ignore, changelog, blame, cherry-pick, worktree, bisect, contributors, undo"],
      }));
  }
}

async function isGitAvailable(cwd: string): Promise<boolean> {
  const result = await runCommand("git --version", cwd);
  return result.exitCode === 0;
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runCommand("git rev-parse --is-inside-work-tree", cwd);
  return result.exitCode === 0 && result.stdout.trim() === "true";
}

async function requireGitRepo(cwd: string, subcommand: string): Promise<boolean> {
  if (await isGitRepo(cwd)) return true;
  printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand, cwd }));
  return false;
}

async function gitInit(cwd: string, flags: GitFlags): Promise<void> {
  if (await isGitRepo(cwd) && !flags.force) {
    console.log(chalk.yellow("Already a git repository. Use --force to reinitialize."));
    return;
  }

  const config = await loadConfig();
  const branch = config.preferences.defaultBranch;

  await runCommandArgs("git", ["init", "-b", branch], cwd);
  console.log(chalk.green(`✓ Initialized git repository (branch: ${branch})`));

  const scan = await scanProject(cwd);
  const gitignoreContent = generateGitignore(scan.language, scan.framework, scan.packageManager);
  const { writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const { existsSync } = await import("fs");

  const gitignorePath = join(cwd, ".gitignore");
  if (!existsSync(gitignorePath) || flags.force) {
    await writeFile(gitignorePath, gitignoreContent);
    console.log(chalk.green("✓ Generated .gitignore based on detected stack"));
  }

  if (scan.packageManager) {
    console.log(chalk.dim(`  Detected: ${scan.language || "unknown"} / ${scan.framework || "none"} / ${scan.packageManager}`));
  }
}

async function gitHooks(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "hooks", cwd }));
    return;
  }

  const action = flags.args?.[0] || "setup";
  const { writeFile, mkdir } = await import("fs/promises");
  const { join } = await import("path");

  const hooksDir = join(cwd, ".git", "hooks");
  await mkdir(hooksDir, { recursive: true });

  if (action === "setup" || action === "install") {
    const scan = await scanProject(cwd);
    const hooks = generateHooks(scan.packageManager, scan.language);

    for (const [name, content] of Object.entries(hooks)) {
      const hookPath = join(hooksDir, name);
      await writeFile(hookPath, content, { mode: 0o755 });
      console.log(chalk.green(`  ✓ ${name}`));
    }
    console.log(chalk.green(`\n✓ Installed ${Object.keys(hooks).length} git hooks`));
  } else if (action === "list") {
    const { readdir } = await import("fs/promises");
    const files = await readdir(hooksDir).catch(() => []);
    const hooks = files.filter(f => !f.endsWith(".sample"));
    if (hooks.length === 0) {
      console.log(chalk.dim("No custom hooks installed."));
    } else {
      console.log(chalk.blue.bold("\n  Git Hooks\n"));
      for (const hook of hooks) {
        console.log(`  ${chalk.green("●")} ${hook}`);
      }
    }
  } else if (action === "remove") {
    const { rm } = await import("fs/promises");
    const { readdir } = await import("fs/promises");
    const files = await readdir(hooksDir).catch(() => []);
    for (const f of files.filter(f => !f.endsWith(".sample"))) {
      await rm(join(hooksDir, f)).catch(() => {});
    }
    console.log(chalk.green("✓ Removed all custom git hooks"));
  }
}

async function gitFlow(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "flow", cwd }));
    return;
  }

  const action = flags.args?.[0] || "status";
  const config = await loadConfig();
  const main = config.preferences.defaultBranch;

  if (action === "feature") {
    const name = flags.args?.[1];
    if (!name) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "flow", cwd, details: ["Usage: setupr git flow feature <name>"] }));
      return;
    }
    await runCommandArgs("git", ["checkout", "-b", `feature/${name}`], cwd);
    console.log(chalk.green(`✓ Created and switched to feature/${name}`));
  } else if (action === "hotfix") {
    const name = flags.args?.[1];
    if (!name) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "flow", cwd, details: ["Usage: setupr git flow hotfix <name>"] }));
      return;
    }
    await runCommandArgs("git", ["checkout", main], cwd);
    await runCommandArgs("git", ["pull"], cwd);
    await runCommandArgs("git", ["checkout", "-b", `hotfix/${name}`], cwd);
    console.log(chalk.green(`✓ Created hotfix/${name} from ${main}`));
  } else if (action === "release") {
    const version = flags.args?.[1];
    if (!version) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "flow", cwd, details: ["Usage: setupr git flow release <version>"] }));
      return;
    }
    await runCommandArgs("git", ["checkout", "-b", `release/${version}`], cwd);
    console.log(chalk.green(`✓ Created release/${version}`));
  } else if (action === "finish") {
    const result = await runCommand("git branch --show-current", cwd);
    const branch = result.stdout.trim();
    if (branch.startsWith("feature/") || branch.startsWith("hotfix/") || branch.startsWith("release/")) {
      await runCommandArgs("git", ["checkout", main], cwd);
      await runCommandArgs("git", ["merge", "--no-ff", branch], cwd);
      console.log(chalk.green(`✓ Merged ${branch} into ${main}`));
    } else {
      console.log(chalk.yellow("Not on a flow branch (feature/, hotfix/, release/)."));
    }
  } else {
    const result = await runCommand("git branch --show-current", cwd);
    const branch = result.stdout.trim();
    console.log(chalk.blue.bold("\n  Git Flow Status\n"));
    console.log(`  Current branch: ${chalk.white(branch)}`);
    console.log(`  Main branch:    ${chalk.white(main)}`);
    console.log("");
    console.log(chalk.dim("  Commands: feature <name>, hotfix <name>, release <version>, finish"));
  }
}

async function gitCommitMessage(cwd: string): Promise<void> {
  if (!await requireGitRepo(cwd, "commit-message")) return;

  const stagedFiles = (await runCommand("git diff --cached --name-only", cwd)).stdout.trim().split("\n").filter(Boolean);
  const unstagedFiles = (await runCommand("git diff --name-only", cwd)).stdout.trim().split("\n").filter(Boolean);
  const untrackedFiles = await gitUntrackedFiles(cwd);
  const files = (stagedFiles.length > 0 ? stagedFiles : [...unstagedFiles, ...untrackedFiles]).filter((file) => !isSetuprInternalPath(file));
  if (files.length === 0) {
    console.log(chalk.yellow("No changed files found."));
    return;
  }

  const stat = await runCommand(stagedFiles.length > 0 ? "git diff --cached --stat" : "git diff --stat", cwd);
  const type = inferCommitType(files);
  const scope = inferCommitScope(files);
  const subject = summarizeChangedFiles(files);
  const message = `${type}${scope ? `(${scope})` : ""}: ${subject}`;

  console.log(chalk.blue.bold("\n  Suggested Commit Message\n"));
  console.log(chalk.white(`  ${message}`));
  console.log("");
  if (stat.stdout.trim()) console.log(chalk.dim(stat.stdout.trim()));
  console.log(chalk.dim("\n  Review before committing. Use: setupr git commit \"<message>\""));
}

async function gitCommit(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "commit", cwd }));
    return;
  }

  const config = await loadConfig();
  const convention = config.preferences.commitConvention;

  const statusResult = await runCommand("git status --porcelain", cwd);
  if (!statusResult.stdout.trim()) {
    console.log(chalk.yellow("Nothing to commit — working tree clean."));
    return;
  }

  const stagedResult = await runCommand("git diff --cached --name-only", cwd);
  if (!stagedResult.stdout.trim()) {
    await runCommand("git add -A", cwd);
    console.log(chalk.dim("  Staged all changes."));
  }

  let message = flags.message || flags.args?.[0];
  if (!message) {
    const diffResult = await runCommand("git diff --cached --stat", cwd);
    console.log(chalk.blue.bold("\n  Changes to commit:\n"));
    console.log(diffResult.stdout);

    if (convention === "conventional" || convention === "angular") {
      console.log(chalk.dim("\n  Format: <type>(<scope>): <description>"));
      console.log(chalk.dim("  Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build"));
    }

    if (process.stdin.isTTY) {
      const { createInterface } = await import("readline");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      message = await new Promise<string>((r) => rl.question("  Commit message: ", r));
      rl.close();
    }
  }

  if (!message || !message.trim()) {
    console.log(chalk.yellow("Commit cancelled — no message provided."));
    return;
  }

  if (convention === "conventional" && !/^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\(.+\))?!?:/.test(message)) {
    console.log(chalk.yellow(`  ⚠ Message doesn't follow conventional commit format.`));
    if (!flags.force) {
      console.log(chalk.dim("  Use --force to commit anyway."));
      return;
    }
  }

  const result = await runCommandArgs("git", ["commit", "-m", message], cwd);
  if (result.exitCode === 0) {
    console.log(chalk.green(`✓ Committed: ${message}`));
  } else {
    printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "commit", cwd, details: [result.stderr] }));
  }
}

async function gitPRDescription(cwd: string): Promise<void> {
  if (!await requireGitRepo(cwd, "pr-description")) return;

  const branch = (await runCommand("git branch --show-current", cwd)).stdout.trim() || "current branch";
  const base = await detectMainBranch(cwd);
  const range = base ? `${base}...HEAD` : "HEAD";
  let log = await runCommandArgs("git", ["log", "--oneline", range, "--"], cwd);
  if (log.exitCode !== 0) log = await runCommandArgs("git", ["log", "--oneline", "-10", "--"], cwd);
  const commits = log.stdout.trim().split("\n").filter(Boolean);
  let stat = await runCommandArgs("git", ["diff", "--stat", range, "--"], cwd);
  if (stat.exitCode !== 0) stat = await runCommandArgs("git", ["diff", "--stat", "HEAD~1..HEAD", "--"], cwd);
  let names = await runCommandArgs("git", ["diff", "--name-only", range, "--"], cwd);
  if (names.exitCode !== 0) names = await runCommandArgs("git", ["diff", "--name-only", "HEAD~1..HEAD", "--"], cwd);
  const files = names.stdout.trim().split("\n").filter(Boolean);

  console.log(chalk.blue.bold("\n  PR Description Draft\n"));
  console.log(`## Summary`);
  if (commits.length === 0 && files.length === 0) {
    console.log("- No branch diff found yet.");
  } else {
    for (const line of summarizeFilesByArea(files)) console.log(`- ${line}`);
  }
  console.log("\n## Changes");
  for (const commit of commits.slice(0, 10)) console.log(`- ${commit.replace(/^[a-f0-9]+\s+/, "")}`);
  if (commits.length === 0) console.log("- No commits found in comparison range.");
  console.log("\n## Testing");
  console.log("- Not run by Setupr automatically. Fill this in before opening the PR.");
  console.log("");
  console.log(chalk.dim(`Branch: ${branch}${base ? ` · Base: ${base}` : ""}`));
  if (stat.stdout.trim()) console.log(chalk.dim(stat.stdout.trim()));
}

async function gitBranchCheck(cwd: string): Promise<void> {
  if (!await requireGitRepo(cwd, "branch-check")) return;

  const branch = (await runCommand("git branch --show-current", cwd)).stdout.trim();
  const base = await detectMainBranch(cwd);
  const dirty = (await gitStatusPaths(cwd)).filter((file) => !isSetuprInternalPath(file));
  const aheadBehind = base ? (await runCommandArgs("git", ["rev-list", "--left-right", "--count", `${base}...HEAD`, "--"], cwd)).stdout.trim() : "";
  const [behind = "0", ahead = "0"] = aheadBehind.split(/\s+/);

  console.log(chalk.blue.bold("\n  Branch Strategy Check\n"));
  if (!branch) {
    console.log(chalk.yellow("  Detached HEAD. Create or switch to a branch before feature work."));
  } else {
    const onMain = ["main", "master", "trunk"].includes(branch);
    console.log(`  Current branch: ${onMain ? chalk.yellow(branch) : chalk.green(branch)}`);
    if (onMain) console.log(chalk.yellow("  Warning: you are on the main branch. Create a feature branch before risky changes."));
  }
  console.log(`  Working tree:   ${dirty.length === 0 ? chalk.green("clean") : chalk.yellow(`${dirty.length} changed file(s)`)}`);
  if (base) console.log(`  Compared with:  ${base} (${ahead} ahead, ${behind} behind)`);
  console.log("");
}

async function gitConflicts(cwd: string): Promise<void> {
  if (!await requireGitRepo(cwd, "conflicts")) return;

  const unmerged = (await runCommand("git diff --name-only --diff-filter=U", cwd)).stdout.trim().split("\n").filter(Boolean);
  const markerFiles = (await runCommand([
    "git grep --untracked -n",
    "-e \"^<<<<<<<\" -e \"^=======\" -e \"^>>>>>>>\"",
    "-- .",
    "\":(exclude)node_modules/**\"",
    "\":(exclude).git/**\"",
    "\":(exclude).setupr/**\"",
    "\":(exclude)dist/**\"",
    "\":(exclude)build/**\"",
    "\":(exclude)coverage/**\"",
    "\":(exclude).next/**\"",
    "2>/dev/null || true",
  ].join(" "), cwd)).stdout.trim().split("\n").filter(Boolean);

  console.log(chalk.blue.bold("\n  Conflict Helper\n"));
  if (unmerged.length === 0 && markerFiles.length === 0) {
    console.log(chalk.green("  ✓ No merge conflicts detected."));
    console.log("");
    return;
  }
  if (unmerged.length > 0) {
    console.log(chalk.red("  Unmerged files:"));
    for (const file of unmerged) console.log(`  - ${file}`);
  }
  if (markerFiles.length > 0) {
    console.log(chalk.yellow("\n  Conflict markers:"));
    for (const line of markerFiles.slice(0, 20)) console.log(`  - ${line}`);
    if (markerFiles.length > 20) console.log(chalk.dim(`  ...${markerFiles.length - 20} more marker lines`));
  }
  console.log(chalk.dim("\n  Resolve each file, run git add <file>, then continue the merge/rebase/cherry-pick."));
}

async function gitBranch(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "branch", cwd }));
    return;
  }

  const action = flags.args?.[0];

  if (!action || action === "list") {
    const result = await runCommand("git branch -a --format='%(refname:short) %(upstream:short) %(committerdate:relative)'", cwd);
    console.log(chalk.blue.bold("\n  Branches\n"));
    const current = (await runCommand("git branch --show-current", cwd)).stdout.trim();
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      const parts = line.split(" ");
      const name = parts[0];
      const marker = name === current ? chalk.green("● ") : "  ";
      console.log(`${marker}${name === current ? chalk.green(name) : chalk.white(name)} ${chalk.dim(parts.slice(1).join(" "))}`);
    }
    console.log("");
  } else if (action === "create") {
    const name = flags.args?.[1];
    if (!name) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "branch", cwd, details: ["Usage: setupr git branch create <name>"] }));
      return;
    }
    const result = await runCommandArgs("git", ["checkout", "-b", name], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Created and switched to ${name}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_BRANCH_EXISTS", command: "git", subcommand: "branch", cwd, details: [result.stderr] }));
    }
  } else if (action === "delete") {
    const name = flags.args?.[1];
    if (!name) return;
    const flag = flags.force ? "-D" : "-d";
    const result = await runCommandArgs("git", ["branch", flag, name], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Deleted branch ${name}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "branch", cwd, details: [result.stderr] }));
    }
  } else if (action === "switch") {
    const name = flags.args?.[1];
    if (!name) return;
    const result = await runCommandArgs("git", ["checkout", name], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Switched to ${name}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "branch", cwd, details: [result.stderr] }));
    }
  } else {
    const result = await runCommandArgs("git", ["checkout", action], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Switched to ${action}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "branch", cwd, details: [result.stderr] }));
    }
  }
}

async function gitPR(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "pr", cwd }));
    return;
  }

  const action = flags.args?.[0] || "create";
  if (!["create", "list", "status"].includes(action)) {
    printPlainError(createSetuprError({ code: "UNKNOWN_SUBCOMMAND", command: "git", subcommand: "pr", cwd, details: ["Valid PR actions: create, list, status."] }));
    return;
  }
  const repoArgs: string[] = [];
  if (flags.remote !== undefined) {
    const remote = selectGitRemote(await readGitRemotes(cwd), flags.remote, { githubOnly: true });
    if (!remote) {
      printPlainError(createSetuprError({ code: "GIT_REMOTE_MISSING", command: "git", subcommand: "pr", cwd, details: ["The selected --remote must have a supported GitHub repository URL."] }));
      return;
    }
    repoArgs.push("--repo", remote.githubRepo!);
  }

  const ghCheck = await runCommandArgs("gh", ["--version"], cwd);
  if (ghCheck.exitCode !== 0) {
    if (action !== "create") {
      printPlainError(createSetuprError({ code: "COMMAND_NOT_FOUND", command: "git", subcommand: "pr", cwd, details: ["GitHub CLI (gh) is required to list PRs or inspect their status. No push was attempted."] }));
      return;
    }
    const branch = (await runCommandArgs("git", ["branch", "--show-current"], cwd)).stdout.trim();
    if (!branch) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "pr", cwd, details: ["Cannot push a PR from detached HEAD. Switch to a branch first."] }));
      return;
    }
    const remote = await requirePushRemote(cwd, "pr", branch, flags.remote);
    if (!remote) return;
    if (!remote.githubRepo) {
      printPlainError(createSetuprError({ code: "GIT_REMOTE_MISSING", command: "git", subcommand: "pr", cwd, details: ["The push destination is not a supported GitHub repository. Select a GitHub remote with --remote."] }));
      return;
    }
    console.log(chalk.yellow("GitHub CLI (gh) not installed. Install from https://cli.github.com"));
    console.log(chalk.dim("  Falling back to push + URL..."));
    const pushResult = await runCommandArgs("git", ["push", "-u", "--", remote.name, `HEAD:refs/heads/${branch}`], cwd);
    if (pushResult.exitCode === 0) {
      console.log(chalk.green(`✓ Pushed. Create PR at: https://github.com/${remote.githubRepo}/compare/${encodeURIComponent(branch)}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_PUSH_FAILED", command: "git", subcommand: "pr", cwd, details: [redactGitOutput(pushResult.stderr)] }));
    }
    return;
  }

  if (action === "create") {
    const title = flags.args?.[1] || flags.message;
    const result = title
      ? await runCommandArgs("gh", ["pr", "create", ...repoArgs, "--title", title, "--fill"], cwd)
      : await runCommandArgs("gh", ["pr", "create", ...repoArgs, "--fill"], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ PR created: ${redactGitOutput(result.stdout.trim())}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "pr", cwd, details: [redactGitOutput(result.stderr)] }));
    }
  } else if (action === "list") {
    const result = await runCommandArgs("gh", ["pr", "list", ...repoArgs], cwd);
    if (result.exitCode !== 0) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "pr", cwd, details: [redactGitOutput(result.stderr)] }));
      return;
    }
    console.log(redactGitOutput(result.stdout) || chalk.dim("No open PRs."));
  } else if (action === "status") {
    const result = await runCommandArgs("gh", ["pr", "status", ...repoArgs], cwd);
    if (result.exitCode !== 0) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "pr", cwd, details: [redactGitOutput(result.stderr)] }));
      return;
    }
    console.log(redactGitOutput(result.stdout));
  }
}

async function gitStash(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "stash", cwd }));
    return;
  }

  const action = flags.args?.[0] || "push";

  if (action === "push" || action === "save") {
    const message = flags.args?.slice(1).join(" ") || flags.message || "";
    const result = message
      ? await runCommandArgs("git", ["stash", "push", "-u", "-m", message], cwd)
      : await runCommandArgs("git", ["stash", "push", "-u"], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Stashed changes${message ? `: ${message}` : ""}`));
    } else {
      console.log(chalk.yellow("Nothing to stash."));
    }
  } else if (action === "pop") {
    const result = await runCommand("git stash pop", cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green("✓ Applied and dropped latest stash"));
    } else {
      printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "stash", cwd, details: [result.stderr] }));
    }
  } else if (action === "list") {
    const result = await runCommand("git stash list", cwd);
    if (!result.stdout.trim()) {
      console.log(chalk.dim("No stashes."));
    } else {
      console.log(chalk.blue.bold("\n  Stash List\n"));
      console.log(result.stdout);
    }
  } else if (action === "apply") {
    const index = flags.args?.[1] || "0";
    const result = await runCommandArgs("git", ["stash", "apply", `stash@{${index}}`], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Applied stash@{${index}}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "stash", cwd, details: [result.stderr] }));
    }
  } else if (action === "drop") {
    const index = flags.args?.[1] || "0";
    const result = await runCommandArgs("git", ["stash", "drop", `stash@{${index}}`], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Dropped stash@{${index}}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "stash", cwd, details: [result.stderr] }));
    }
  } else if (action === "clear") {
    if (!flags.force) {
      console.log(chalk.yellow("This will delete all stashes. Use --force to confirm."));
      return;
    }
    await runCommand("git stash clear", cwd);
    console.log(chalk.green("✓ Cleared all stashes"));
  }
}

async function gitRebase(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "rebase", cwd }));
    return;
  }

  const target = flags.args?.[0];
  if (!target) {
    const config = await loadConfig();
    const main = config.preferences.defaultBranch;
    console.log(chalk.blue(`Rebasing onto ${main}...`));
    const result = await runCommandArgs("git", ["rebase", main], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Rebased onto ${main}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "rebase", cwd, details: ["Run 'git rebase --abort' to cancel or resolve conflicts manually."] }));
    }
    return;
  }

  if (target === "abort") {
    await runCommand("git rebase --abort", cwd);
    console.log(chalk.green("✓ Rebase aborted"));
  } else if (target === "continue") {
    const result = await runCommand("git rebase --continue", cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green("✓ Rebase continued"));
    } else {
      printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "rebase", cwd, details: [result.stderr] }));
    }
  } else {
    const result = await runCommandArgs("git", ["rebase", target], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Rebased onto ${target}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "rebase", cwd, details: [result.stderr] }));
    }
  }
}

async function gitTag(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "tag", cwd }));
    return;
  }

  const action = flags.args?.[0];

  if (!action || action === "list") {
    const result = await runCommand("git tag -l --sort=-creatordate", cwd);
    if (!result.stdout.trim()) {
      console.log(chalk.dim("No tags."));
    } else {
      console.log(chalk.blue.bold("\n  Tags\n"));
      for (const tag of result.stdout.trim().split("\n").slice(0, 20)) {
        console.log(`  ${chalk.green(tag)}`);
      }
    }
  } else if (action === "create") {
    const version = flags.args?.[1];
    if (!version) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "tag", cwd, details: ["Usage: setupr git tag create <version>"] }));
      return;
    }
    const message = flags.message || `Release ${version}`;
    const result = await runCommandArgs("git", ["tag", "-a", version, "-m", message], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Created tag ${version}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "tag", cwd, details: [result.stderr] }));
    }
  } else if (action === "push") {
    const result = await runCommand("git push --tags", cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green("✓ Pushed all tags to remote"));
    } else {
      printPlainError(createSetuprError({ code: "GIT_PUSH_FAILED", command: "git", subcommand: "tag", cwd, details: [result.stderr] }));
    }
  } else if (action === "delete") {
    const tag = flags.args?.[1];
    if (!tag) return;
    await runCommandArgs("git", ["tag", "-d", tag], cwd);
    console.log(chalk.green(`✓ Deleted local tag ${tag}`));
  } else {
    const version = action;
    const message = flags.message || `Release ${version}`;
    const result = await runCommandArgs("git", ["tag", "-a", version, "-m", message], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Created tag ${version}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "tag", cwd, details: [result.stderr] }));
    }
  }
}

async function gitRelease(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "release", cwd }));
    return;
  }

  const version = flags.args?.[0];
  if (!version) {
    const { readFile } = await import("fs/promises");
    const { join } = await import("path");
    try {
      const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8"));
      console.log(chalk.blue.bold("\n  Release Info\n"));
      console.log(`  Current version: ${chalk.white(pkg.version || "unknown")}`);
      console.log(chalk.dim("\n  Usage: setupr git release <version>"));
      console.log(chalk.dim("  Example: setupr git release 1.2.0"));
    } catch {
      console.log(chalk.dim("Usage: setupr git release <version>"));
    }
    return;
  }

  console.log(chalk.blue(`Creating release ${version}...`));

  const { readFile, writeFile } = await import("fs/promises");
  const { join } = await import("path");

  try {
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    pkg.version = version;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    console.log(chalk.green(`  ✓ Updated package.json version to ${version}`));
  } catch {}

  await runCommand("git add -A", cwd);
  await runCommandArgs("git", ["commit", "-m", `chore: release ${version}`], cwd);
  console.log(chalk.green(`  ✓ Committed release`));

  await runCommandArgs("git", ["tag", "-a", `v${version}`, "-m", `Release ${version}`], cwd);
  console.log(chalk.green(`  ✓ Tagged v${version}`));

  const ghCheck = await runCommand("gh --version", cwd);
  if (ghCheck.exitCode === 0) {
    const result = await runCommandArgs("gh", ["release", "create", `v${version}`, "--title", `v${version}`, "--generate-notes"], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`  ✓ GitHub release created`));
    }
  }

  console.log(chalk.green(`\n✓ Release ${version} complete`));
  console.log(chalk.dim("  Push with: git push && git push --tags"));
}

async function gitStatus(cwd: string): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "status", cwd }));
    return;
  }

  const [branchResult, statusResult, aheadBehind] = await Promise.all([
    runCommand("git branch --show-current", cwd),
    runCommand("git status --porcelain", cwd),
    runCommand("git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null", cwd),
  ]);

  const branch = branchResult.stdout.trim();
  const lines = statusResult.stdout.trim().split("\n").filter(Boolean);

  console.log(chalk.blue.bold("\n  Git Status\n"));
  console.log(`  Branch: ${chalk.green(branch)}`);

  if (aheadBehind.exitCode === 0) {
    const [ahead, behind] = aheadBehind.stdout.trim().split(/\s+/).map(Number);
    if (ahead > 0) console.log(chalk.yellow(`  ↑ ${ahead} commit${ahead > 1 ? "s" : ""} ahead`));
    if (behind > 0) console.log(chalk.yellow(`  ↓ ${behind} commit${behind > 1 ? "s" : ""} behind`));
    if (ahead === 0 && behind === 0) console.log(chalk.green("  ✓ Up to date with remote"));
  }

  if (lines.length === 0) {
    console.log(chalk.green("  ✓ Working tree clean"));
  } else {
    const staged = lines.filter(l => l[0] !== " " && l[0] !== "?");
    const modified = lines.filter(l => l[1] !== " " && l[0] !== "?");
    const untracked = lines.filter(l => l.startsWith("??"));

    if (staged.length > 0) console.log(chalk.green(`  ${staged.length} staged`));
    if (modified.length > 0) console.log(chalk.yellow(`  ${modified.length} modified`));
    if (untracked.length > 0) console.log(chalk.dim(`  ${untracked.length} untracked`));
  }
  console.log("");
}

async function gitLog(cwd: string): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "log", cwd }));
    return;
  }

  const result = await runCommand('git log --oneline --graph --decorate -20', cwd);
  console.log(chalk.blue.bold("\n  Recent Commits\n"));
  console.log(result.stdout);
}

async function gitSync(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "sync", cwd }));
    return;
  }

  const branch = (await runCommandArgs("git", ["branch", "--show-current"], cwd)).stdout.trim();
  if (!branch) {
    printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "sync", cwd, details: ["Cannot sync detached HEAD. Switch to a branch first."] }));
    return;
  }
  // Tracking configuration can exist even before its remote-tracking ref is fetched.
  const trackingRemote = await runCommandArgs("git", ["config", "--get", `branch.${branch}.remote`], cwd);
  const trackingBranch = await runCommandArgs("git", ["config", "--get", `branch.${branch}.merge`], cwd);
  const hasUpstream = trackingRemote.exitCode === 0 && Boolean(trackingRemote.stdout.trim())
    && trackingBranch.exitCode === 0 && Boolean(trackingBranch.stdout.trim());
  const needsRemote = flags.remote !== undefined || !hasUpstream;
  const remote = needsRemote ? await requirePushRemote(cwd, "sync", branch, flags.remote) : null;
  if (needsRemote && !remote) return;

  console.log(chalk.blue("Syncing with remote..."));
  if (hasUpstream) {
    const pullResult = await runCommandArgs("git", ["pull", "--rebase", ...(remote ? ["--", remote.name, branch] : [])], cwd);
    if (pullResult.exitCode !== 0) {
      printPlainError(createSetuprError({
        code: /conflict/i.test(`${pullResult.stdout}\n${pullResult.stderr}`) ? "GIT_MERGE_CONFLICT" : "GIT_COMMAND_FAILED",
        command: "git", subcommand: "sync", cwd, details: [redactGitOutput(pullResult.stderr || pullResult.stdout)],
      }));
      return;
    }
    console.log(chalk.green("  ✓ Pulled latest changes"));
  }

  const pushResult = await runCommandArgs("git", ["push", ...(remote ? ["-u", "--", remote.name, `HEAD:refs/heads/${branch}`] : [])], cwd);
  if (pushResult.exitCode !== 0) {
    printPlainError(createSetuprError({ code: "GIT_PUSH_FAILED", command: "git", subcommand: "sync", cwd, details: [redactGitOutput(pushResult.stderr)] }));
    return;
  }
  console.log(chalk.green(remote ? `  ✓ Set upstream and pushed ${branch} to ${remote.name}` : "  ✓ Pushed local commits"));

  console.log(chalk.green("\n✓ Synced"));
}

async function requirePushRemote(cwd: string, subcommand: string, branch: string, name?: string): Promise<GitRemote | null> {
  const remotes = await readGitRemotes(cwd, { push: true });
  let selectedName = name;
  if (selectedName === undefined) {
    for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault"]) {
      const result = await runCommandArgs("git", ["config", "--get", key], cwd);
      if (result.exitCode === 0) {
        selectedName = result.stdout.trim();
        break;
      }
    }
    selectedName ??= remotes.find((remote) => remote.name === "origin")?.name ?? (remotes.length === 1 ? remotes[0].name : "");
  }
  const remote = selectGitRemote(remotes, selectedName);
  if (!remote || remote.urls.length !== 1) {
    printPlainError(createSetuprError({
      code: "GIT_REMOTE_MISSING", command: "git", subcommand, cwd,
      details: ["Select a configured push remote with --remote <name>. It must have exactly one push URL; multiple non-origin remotes require an explicit choice."],
    }));
    return null;
  }
  return remote;
}

async function gitClean(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "clean", cwd }));
    return;
  }

  const action = flags.args?.[0] || "merged";

  if (action === "merged") {
    const config = await loadConfig();
    const main = config.preferences.defaultBranch;
    const result = await runCommandArgs("git", ["branch", "--merged", main], cwd);
    const branches = result.stdout.trim().split("\n")
      .map(b => b.trim())
      .filter(b => b && !b.startsWith("*") && b !== main && b !== "master" && b !== "develop");

    if (branches.length === 0) {
      console.log(chalk.green("✓ No merged branches to clean."));
      return;
    }

    console.log(chalk.blue(`Found ${branches.length} merged branch(es):`));
    for (const b of branches) {
      console.log(chalk.dim(`  ${b}`));
    }

    if (flags.force) {
      for (const b of branches) {
        await runCommandArgs("git", ["branch", "-d", b], cwd);
      }
      console.log(chalk.green(`✓ Deleted ${branches.length} merged branches`));
    } else {
      console.log(chalk.dim("\n  Use --force to delete them."));
    }
  }
}

function generateGitignore(language: string | null, framework: string | null, pm: string | null): string {
  const lang = (language || "").toLowerCase();
  const lines: string[] = ["# Dependencies", "node_modules/", ".pnp.*", ".yarn/"];

  if (pm === "pnpm") lines.push(".pnpm-store/");

  lines.push("", "# Build output", "dist/", "build/", "out/", ".next/", ".nuxt/", ".output/");

  if (lang === "typescript" || lang === "javascript") {
    lines.push("", "# TypeScript", "*.tsbuildinfo");
  }
  if (lang === "python") {
    lines.push("", "# Python", "__pycache__/", "*.py[cod]", ".venv/", "venv/", "*.egg-info/");
  }
  if (lang === "rust") {
    lines.push("", "# Rust", "target/", "Cargo.lock");
  }
  if (lang === "go") {
    lines.push("", "# Go", "vendor/");
  }

  lines.push("", "# Environment", ".env", ".env.local", ".env.*.local");
  lines.push("", "# IDE", ".vscode/", ".idea/", "*.swp", "*.swo", ".DS_Store");
  lines.push("", "# Testing", "coverage/", ".nyc_output/");
  lines.push("", "# Logs", "*.log", "npm-debug.log*", "yarn-debug.log*", "pnpm-debug.log*");
  lines.push("", "# Setupr", ".setupr/");

  return lines.join("\n") + "\n";
}

async function gitIgnore(cwd: string, flags: GitFlags): Promise<void> {
  const { writeFile } = await import("fs/promises");
  const { join } = await import("path");
  const { existsSync } = await import("fs");

  const scan = await scanProject(cwd);
  const content = generateGitignore(scan.language, scan.framework, scan.packageManager);
  const gitignorePath = join(cwd, ".gitignore");

  if (existsSync(gitignorePath) && !flags.force) {
    // Append new entries that aren't already present
    const { readFile } = await import("fs/promises");
    const existing = await readFile(gitignorePath, "utf-8");
    const existingLines = new Set(existing.split("\n").map(l => l.trim()));
    const newEntries = content.split("\n").filter(l => l.trim() && !l.startsWith("#") && !existingLines.has(l.trim()));

    if (newEntries.length === 0) {
      console.log(chalk.green("✓ .gitignore is already comprehensive."));
      return;
    }

    const updated = existing.trimEnd() + "\n\n# Added by Setupr\n" + newEntries.join("\n") + "\n";
    await writeFile(gitignorePath, updated);
    console.log(chalk.green(`✓ Added ${newEntries.length} entries to .gitignore`));
  } else {
    await writeFile(gitignorePath, content);
    console.log(chalk.green("✓ Generated .gitignore"));
  }
  console.log(chalk.dim(`  Stack: ${scan.language || "unknown"} / ${scan.framework || "none"} / ${scan.packageManager || "npm"}`));
}

async function gitChangelog(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "changelog", cwd }));
    return;
  }

  const sinceTag = flags.args?.[0];
  const cmd = sinceTag
    ? `git log ${sinceTag}..HEAD --pretty=format:"%h %s (%an, %ar)"`
    : `git log --pretty=format:"%h %s (%an, %ar)" -50`;

  const result = await runCommand(cmd, cwd);
  if (!result.stdout.trim()) {
    console.log(chalk.dim("No commits found."));
    return;
  }

  const lines = result.stdout.trim().split("\n");
  const groups: Record<string, string[]> = {
    feat: [], fix: [], docs: [], refactor: [], chore: [], other: [],
  };

  for (const line of lines) {
    const match = line.match(/^[a-f0-9]+ (feat|fix|docs|refactor|chore|perf|test|ci|build|style|revert)(\(.+?\))?:?\s*(.+)$/);
    if (match) {
      const type = match[1] === "perf" || match[1] === "test" || match[1] === "ci" || match[1] === "build" || match[1] === "style" || match[1] === "revert" ? "other" : match[1];
      groups[type].push(line);
    } else {
      groups.other.push(line);
    }
  }

  console.log(chalk.blue.bold("\n  Changelog\n"));
  if (sinceTag) console.log(chalk.dim(`  Since: ${sinceTag}\n`));

  const labels: Record<string, string> = {
    feat: "Features", fix: "Bug Fixes", docs: "Documentation", refactor: "Refactoring", chore: "Chores", other: "Other",
  };

  for (const [type, commits] of Object.entries(groups)) {
    if (commits.length === 0) continue;
    console.log(chalk.white(`  ${labels[type]} (${commits.length})`));
    for (const c of commits.slice(0, 10)) {
      console.log(chalk.dim(`    ${c}`));
    }
    if (commits.length > 10) console.log(chalk.dim(`    ... and ${commits.length - 10} more`));
    console.log("");
  }

  // Optionally write to file
  if (flags.force) {
    const { writeFile } = await import("fs/promises");
    const { join } = await import("path");
    let md = `# Changelog\n\n`;
    if (sinceTag) md += `## Changes since ${sinceTag}\n\n`;
    for (const [type, commits] of Object.entries(groups)) {
      if (commits.length === 0) continue;
      md += `### ${labels[type]}\n\n`;
      for (const c of commits) md += `- ${c}\n`;
      md += "\n";
    }
    await writeFile(join(cwd, "CHANGELOG.md"), md);
    console.log(chalk.green("✓ Written to CHANGELOG.md"));
  }
}

async function gitBlame(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "blame", cwd }));
    return;
  }

  const file = flags.args?.[0];
  if (!file) {
    printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "blame", cwd, details: ["Usage: setupr git blame <file>"] }));
    return;
  }

  const lineRange = flags.args?.[1];
  const result = lineRange
    ? await runCommandArgs("git", ["blame", "-L", lineRange, file], cwd)
    : await runCommandArgs("git", ["blame", "--color-lines", file], cwd);
  if (result.exitCode === 0) {
    console.log(chalk.blue.bold(`\n  Blame: ${file}\n`));
    console.log(result.stdout);
  } else {
    printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "blame", cwd, details: [result.stderr] }));
  }
}

async function gitCherryPick(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "cherry-pick", cwd }));
    return;
  }

  const commit = flags.args?.[0];
  if (!commit) {
    printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "cherry-pick", cwd, details: ["Usage: setupr git cherry-pick <commit-hash>"] }));
    return;
  }

  if (commit === "abort") {
    await runCommand("git cherry-pick --abort", cwd);
    console.log(chalk.green("✓ Cherry-pick aborted"));
    return;
  }
  if (commit === "continue") {
    const result = await runCommand("git cherry-pick --continue", cwd);
    if (result.exitCode === 0) console.log(chalk.green("✓ Cherry-pick continued"));
    else printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "cherry-pick", cwd, details: [result.stderr] }));
    return;
  }

  const result = await runCommandArgs("git", ["cherry-pick", commit], cwd);
  if (result.exitCode === 0) {
    console.log(chalk.green(`✓ Cherry-picked ${commit}`));
  } else {
    printPlainError(createSetuprError({ code: "GIT_MERGE_CONFLICT", command: "git", subcommand: "cherry-pick", cwd, details: ["Resolve conflicts, then run: setupr git cherry-pick continue"] }));
  }
}

async function gitWorktree(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "worktree", cwd }));
    return;
  }

  const action = flags.args?.[0] || "list";

  if (action === "list") {
    const result = await runCommand("git worktree list", cwd);
    console.log(chalk.blue.bold("\n  Worktrees\n"));
    console.log(result.stdout || chalk.dim("  Only main worktree."));
  } else if (action === "add") {
    const branch = flags.args?.[1];
    const path = flags.args?.[2] || `../${branch}`;
    if (!branch) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "worktree", cwd, details: ["Usage: setupr git worktree add <branch> [path]"] }));
      return;
    }
    const result = await runCommandArgs("git", ["worktree", "add", path, branch], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Created worktree at ${path} (branch: ${branch})`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "worktree", cwd, details: [result.stderr] }));
    }
  } else if (action === "remove") {
    const path = flags.args?.[1];
    if (!path) return;
    const result = await runCommandArgs("git", ["worktree", "remove", path], cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green(`✓ Removed worktree at ${path}`));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "worktree", cwd, details: [result.stderr] }));
    }
  } else if (action === "prune") {
    await runCommand("git worktree prune", cwd);
    console.log(chalk.green("✓ Pruned stale worktree references"));
  }
}

async function gitBisect(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "bisect", cwd }));
    return;
  }

  const action = flags.args?.[0] || "status";

  if (action === "start") {
    const bad = flags.args?.[1] || "HEAD";
    const good = flags.args?.[2];
    if (!good) {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "bisect", cwd, details: ["Usage: setupr git bisect start [bad] <good>"] }));
      return;
    }
    await runCommandArgs("git", ["bisect", "start", bad, good], cwd);
    console.log(chalk.green(`✓ Bisect started (bad: ${bad}, good: ${good})`));
    console.log(chalk.dim("  Test this commit, then run: setupr git bisect good/bad"));
  } else if (action === "good") {
    const result = await runCommand("git bisect good", cwd);
    console.log(result.stdout);
  } else if (action === "bad") {
    const result = await runCommand("git bisect bad", cwd);
    console.log(result.stdout);
  } else if (action === "reset") {
    await runCommand("git bisect reset", cwd);
    console.log(chalk.green("✓ Bisect session ended"));
  } else if (action === "status") {
    const result = await runCommand("git bisect log 2>/dev/null || echo 'No active bisect session'", cwd);
    console.log(result.stdout);
  }
}

async function gitContributors(cwd: string): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "contributors", cwd }));
    return;
  }

  const result = await runCommand("git shortlog -sn --no-merges HEAD", cwd);
  if (!result.stdout.trim()) {
    console.log(chalk.dim("No contributors found."));
    return;
  }

  console.log(chalk.blue.bold("\n  Contributors\n"));
  const lines = result.stdout.trim().split("\n");
  for (const line of lines.slice(0, 20)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (match) {
      console.log(`  ${chalk.white(match[2].padEnd(30))} ${chalk.dim(match[1] + " commits")}`);
    }
  }
  if (lines.length > 20) console.log(chalk.dim(`\n  ... and ${lines.length - 20} more`));
  console.log("");
}

async function gitUndo(cwd: string, flags: GitFlags): Promise<void> {
  if (!await isGitRepo(cwd)) {
    printPlainError(createSetuprError({ code: "GIT_NOT_A_REPO", command: "git", subcommand: "undo", cwd }));
    return;
  }

  const action = flags.args?.[0] || "commit";

  if (action === "commit") {
    const result = await runCommand("git reset --soft HEAD~1", cwd);
    if (result.exitCode === 0) {
      console.log(chalk.green("✓ Undid last commit (changes kept staged)"));
    } else {
      printPlainError(createSetuprError({ code: "GIT_COMMAND_FAILED", command: "git", subcommand: "undo", cwd, details: [result.stderr] }));
    }
  } else if (action === "stage" || action === "add") {
    await runCommand("git reset HEAD", cwd);
    console.log(chalk.green("✓ Unstaged all changes"));
  } else if (action === "changes") {
    if (!flags.force) {
      console.log(chalk.yellow("This will discard all uncommitted changes. Use --force to confirm."));
      return;
    }
    await runCommand("git checkout -- .", cwd);
    console.log(chalk.green("✓ Discarded all uncommitted changes"));
  } else {
    console.log(chalk.dim("  Usage: setupr git undo [commit|stage|changes]"));
    console.log(chalk.dim("  commit  — undo last commit (keep changes staged)"));
    console.log(chalk.dim("  stage   — unstage all changes"));
    console.log(chalk.dim("  changes — discard all uncommitted changes (--force required)"));
  }
}

async function detectMainBranch(cwd: string): Promise<string | null> {
  const candidates = ["main", "master", "trunk", "develop"];
  const exists = async (ref: string) => (await runCommandArgs("git", ["rev-parse", "--verify", `${ref}^{commit}`], cwd)).exitCode === 0;
  for (const candidate of candidates) {
    const ref = `refs/heads/${candidate}`;
    if (await exists(ref)) return ref;
  }
  for (const remote of await readGitRemotes(cwd)) {
    const prefix = `refs/remotes/${remote.name}/`;
    const head = (await runCommandArgs("git", ["symbolic-ref", "--quiet", `${prefix}HEAD`], cwd)).stdout.trim();
    if (head.startsWith(prefix) && await exists(head)) return head;
    for (const candidate of candidates) {
      const ref = `${prefix}${candidate}`;
      if (await exists(ref)) return ref;
    }
  }
  return null;
}

async function gitUntrackedFiles(cwd: string): Promise<string[]> {
  return (await gitStatusPaths(cwd, "??"));
}

async function gitStatusPaths(cwd: string, prefix?: string): Promise<string[]> {
  const status = await runCommand("git status --porcelain", cwd);
  return status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && (!prefix || line.startsWith(`${prefix} `)))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isSetuprInternalPath(file: string): boolean {
  return file === ".setupr" || file.startsWith(".setupr/");
}

function inferCommitType(files: string[]): string {
  if (files.every((file) => /\.(md|mdx|txt)$/i.test(file))) return "docs";
  if (files.some((file) => /(^|\/)(test|tests|__tests__)\/|\.test\.|\.spec\./i.test(file))) return "test";
  if (files.some((file) => /package(-lock)?\.json|pnpm-lock|yarn\.lock|bun\.lock/i.test(file))) return "build";
  if (files.some((file) => /(^|\/)\.github\/|(^|\/)(Dockerfile|docker-compose|\.gitlab-ci|circleci)/i.test(file))) return "ci";
  if (files.some((file) => /fix|bug|error|exception/i.test(file))) return "fix";
  return "feat";
}

function inferCommitScope(files: string[]): string {
  const first = files[0] || "";
  const parts = first.split("/").filter(Boolean);
  if (parts.length > 1 && ["src", "tests", "test", "packages", "apps"].includes(parts[0])) return sanitizeScope(parts[1]);
  return sanitizeScope(parts[0]?.replace(/\.[^.]+$/, "") || "");
}

function sanitizeScope(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
}

function summarizeChangedFiles(files: string[]): string {
  if (files.length === 1) return `update ${humanFile(files[0])}`;
  const areas = [...new Set(files.map((file) => file.split("/")[0] || file))].slice(0, 3);
  return `update ${areas.join(", ")}${files.length > 3 ? ` and ${files.length - 3} more` : ""}`;
}

function summarizeFilesByArea(files: string[]): string[] {
  if (files.length === 0) return ["No file changes detected in the comparison range."];
  const groups = new Map<string, number>();
  for (const file of files) {
    const area = file.includes("/") ? file.split("/")[0] : "root files";
    groups.set(area, (groups.get(area) || 0) + 1);
  }
  return [...groups.entries()].map(([area, count]) => `Updated ${area} (${count} file${count === 1 ? "" : "s"})`);
}

function humanFile(file: string): string {
  return file.split("/").pop()?.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ") || file;
}

function generateHooks(pm: string | null, language: string | null): Record<string, string> {
  const runner = pm || "npm";
  const lang = (language || "").toLowerCase();
  const hooks: Record<string, string> = {};

  hooks["pre-commit"] = `#!/bin/sh
# Setupr pre-commit hook
# Run lint and format checks before committing

${runner} run lint 2>/dev/null
if [ $? -ne 0 ]; then
  echo "\\n❌ Lint failed. Fix errors before committing."
  exit 1
fi

${lang === "typescript" ? `${runner} run typecheck 2>/dev/null
if [ $? -ne 0 ]; then
  echo "\\n❌ Type check failed. Fix type errors before committing."
  exit 1
fi` : ""}
`;

  hooks["commit-msg"] = `#!/bin/sh
# Setupr commit-msg hook
# Validates conventional commit format

MSG=$(cat "$1")
PATTERN="^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\\(.+\\))?!?: .+"

if ! echo "$MSG" | grep -qE "$PATTERN"; then
  echo "\\n❌ Commit message does not follow conventional format."
  echo "   Format: <type>(<scope>): <description>"
  echo "   Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert"
  exit 1
fi
`;

  hooks["pre-push"] = `#!/bin/sh
# Setupr pre-push hook
# Run tests before pushing

${runner} run test 2>/dev/null
if [ $? -ne 0 ]; then
  echo "\\n❌ Tests failed. Fix before pushing."
  exit 1
fi
`;

  return hooks;
}
