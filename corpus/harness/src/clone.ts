import { realpathSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ManifestEntry } from "./manifest.js";
import { runCommand, type CommandResult } from "./process.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export type CloneRepo = Pick<ManifestEntry, "name" | "gitUrl" | "pinnedSha" | "localPath" | "packageManager">;

export interface EnsureRepoCheckoutOptions {
  context?: CorpusRunContext;
  gitBin?: string;
  workspaceRoot?: string;
}

interface FetchAttempt {
  args: string[];
  result: CommandResult;
  hasCommit: boolean;
}

const defaultWorkspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function runGit(gitBin: string, args: readonly string[], cwd: string): Promise<CommandResult> {
  const targetDir = args[0] === "-C" && args[1] ? args[1] : cwd;
  return runCommand(gitBin, {
    args,
    cwd,
    env: {
      ...process.env,
      // All corpus clones are direct children of .repos. Even if a caller
      // forgets the toplevel identity check, Git must not discover beyond
      // that cache boundary.
      GIT_CEILING_DIRECTORIES: realpathSync(path.dirname(targetDir)),
    },
  });
}

function commandLabel(args: readonly string[], cwd: string): string {
  return `git ${args.join(" ")} (cwd: ${cwd})`;
}

function commandOutput(result: CommandResult): string {
  return (result.stderr || result.stdout).trim();
}

async function checkedGit(gitBin: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await runGit(gitBin, args, cwd);
  if (result.code !== 0) {
    const output = commandOutput(result);
    throw new Error(`${commandLabel(args, cwd)} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout.trim();
}

async function isGitWorkTree(gitBin: string, repoDir: string): Promise<boolean> {
  // corpus/.repos sits inside the Vendo worktree: a cached dir that lost its
  // .git resolves git commands against the ENCLOSING repo, so being inside a
  // work tree is not enough — the work tree's root must be repoDir itself.
  const result = await runGit(gitBin, ["-C", repoDir, "rev-parse", "--show-toplevel"], process.cwd());
  if (result.code !== 0) return false;
  const [toplevel, expected] = await Promise.all([
    realpath(result.stdout.trim()).catch(() => null),
    realpath(repoDir).catch(() => null),
  ]);
  return toplevel !== null && toplevel === expected;
}

async function ensureOrigin(gitBin: string, repoDir: string, gitUrl: string): Promise<void> {
  const result = await runGit(gitBin, ["remote", "get-url", "origin"], repoDir);
  if (result.code === 0) {
    await checkedGit(gitBin, ["remote", "set-url", "origin", gitUrl], repoDir);
    return;
  }
  await checkedGit(gitBin, ["remote", "add", "origin", gitUrl], repoDir);
}

async function initializeWorkTree(gitBin: string, repoDir: string, gitUrl: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await checkedGit(gitBin, ["init"], repoDir);
  await checkedGit(gitBin, ["remote", "add", "origin", gitUrl], repoDir);
}

async function hasCommit(gitBin: string, repoDir: string, sha: string): Promise<boolean> {
  const result = await runGit(gitBin, ["cat-file", "-e", `${sha}^{commit}`], repoDir);
  return result.code === 0;
}

async function isShallowRepository(gitBin: string, repoDir: string): Promise<boolean> {
  const result = await runGit(gitBin, ["rev-parse", "--is-shallow-repository"], repoDir);
  return result.code === 0 && result.stdout.trim() === "true";
}

async function tryFetchCommit(
  gitBin: string,
  repoDir: string,
  sha: string,
  args: string[],
  attempts: FetchAttempt[],
): Promise<boolean> {
  const result = await runGit(gitBin, args, repoDir);
  const fetched = result.code === 0 && await hasCommit(gitBin, repoDir, sha);
  attempts.push({ args, result, hasCommit: fetched });
  return fetched;
}

function formatFetchAttempts(attempts: readonly FetchAttempt[]): string {
  return attempts
    .map((attempt) => {
      const output = commandOutput(attempt.result);
      const status = attempt.result.code === 0
        ? attempt.hasCommit ? "fetched commit" : "completed without pinned commit"
        : `exited ${attempt.result.code ?? "without code"}`;
      return `- git ${attempt.args.join(" ")}: ${status}${output ? `\n  ${output}` : ""}`;
    })
    .join("\n");
}

async function fetchPinnedSha(gitBin: string, repoDir: string, sha: string): Promise<void> {
  const attempts: FetchAttempt[] = [];
  const refspecs = ["+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"];

  if (await tryFetchCommit(gitBin, repoDir, sha, ["fetch", "--depth=1", "--no-tags", "origin", sha], attempts)) return;
  if (await tryFetchCommit(gitBin, repoDir, sha, ["fetch", "--no-tags", "origin", sha], attempts)) return;
  if (await tryFetchCommit(gitBin, repoDir, sha, ["fetch", "--prune", "origin", ...refspecs], attempts)) return;
  if (await isShallowRepository(gitBin, repoDir)) {
    if (await tryFetchCommit(gitBin, repoDir, sha, ["fetch", "--unshallow", "--prune", "origin", ...refspecs], attempts)) return;
  }

  throw new Error(`Unable to fetch pinned SHA ${sha} into ${repoDir}.\n${formatFetchAttempts(attempts)}`);
}

/** A checkout that declares no packageManager inherits corepack's nearest
 * ancestor pin — the Vendo root's, since `.repos/` lives inside the worktree —
 * so the repo silently installs under a package-manager major it was never
 * pinned at. Written after the reset so a reused clone gets it back. */
async function pinPackageManager(repoDir: string, packageManager: string): Promise<void> {
  const packageJsonPath = path.join(repoDir, "package.json");
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as Record<string, unknown>;
  if (pkg["packageManager"] !== undefined) return;
  pkg["packageManager"] = packageManager;
  await writeFile(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

export async function ensureRepoCheckout(repo: CloneRepo, options: EnsureRepoCheckoutOptions = {}): Promise<string> {
  const context = options.context ?? createRunContext();
  const gitBin = options.gitBin ?? "git";
  const repoDir = context.repoDir(repo.name);

  await mkdir(context.reposDir, { recursive: true });
  if (repo.localPath !== undefined) {
    const workspaceRoot = path.resolve(options.workspaceRoot ?? defaultWorkspaceRoot);
    const sourceDir = path.resolve(workspaceRoot, repo.localPath);
    await rm(repoDir, { recursive: true, force: true });
    await cp(sourceDir, repoDir, {
      recursive: true,
      filter(source) {
        const relative = path.relative(sourceDir, source);
        if (relative === "") return true;
        const segments = relative.split(path.sep);
        if (segments.some((segment) => segment === "node_modules" || segment === "dist" || segment === "vendor")) return false;
        return !segments.some((segment, index) => segment === ".vendo" && segments[index + 1] === "data");
      },
    });
    await checkedGit(gitBin, ["init"], repoDir);
    await checkedGit(gitBin, ["add", "-A"], repoDir);
    await checkedGit(gitBin, [
      "-c",
      "user.name=Vendo Corpus",
      "-c",
      "user.email=corpus@vendo.local",
      "commit",
      "-m",
      "Snapshot local corpus source",
    ], repoDir);
    return repoDir;
  }

  if (repo.gitUrl === undefined || repo.pinnedSha === undefined) {
    throw new Error(`Git corpus source ${repo.name} must define gitUrl and pinnedSha`);
  }
  if (!await isGitWorkTree(gitBin, repoDir)) {
    await rm(repoDir, { recursive: true, force: true });
    await initializeWorkTree(gitBin, repoDir, repo.gitUrl);
  } else {
    await ensureOrigin(gitBin, repoDir, repo.gitUrl);
  }

  await fetchPinnedSha(gitBin, repoDir, repo.pinnedSha);
  await checkedGit(gitBin, ["checkout", "--detach", "--force", repo.pinnedSha], repoDir);
  await checkedGit(gitBin, ["reset", "--hard", repo.pinnedSha], repoDir);
  await checkedGit(gitBin, ["clean", "-ffdx"], repoDir);
  if (repo.packageManager !== undefined) await pinPackageManager(repoDir, repo.packageManager);

  return repoDir;
}
