import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRepoCheckout } from "./clone.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface FixtureRepo {
  dir: string;
  gitUrl: string;
  commitFile(content: string): Promise<string>;
}

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function run(command: string, args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function runGit(args: readonly string[], cwd: string): Promise<string> {
  const result = await run("git", args, cwd);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function runGitResult(args: readonly string[], cwd: string): Promise<GitResult> {
  return run("git", args, cwd);
}

async function makeTempRoot(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `vendo-corpus-${label}-`));
  tempRoots.push(root);
  return root;
}

async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = await makeTempRoot("source");
  const dir = path.join(root, "source");
  await mkdir(dir);
  await runGit(["init"], dir);
  await runGit(["checkout", "-b", "main"], dir);
  await runGit(["config", "user.email", "corpus@example.com"], dir);
  await runGit(["config", "user.name", "Corpus Test"], dir);

  return {
    dir,
    gitUrl: pathToFileURL(dir).href,
    async commitFile(content: string): Promise<string> {
      await writeFile(path.join(dir, "app.txt"), content);
      await runGit(["add", "app.txt"], dir);
      await runGit(["commit", "-m", `write ${content}`], dir);
      return runGit(["rev-parse", "HEAD"], dir);
    },
  };
}

function entry(gitUrl: string, pinnedSha: string): Pick<ManifestEntry, "name" | "gitUrl" | "pinnedSha"> {
  return {
    name: "fixture-app",
    gitUrl,
    pinnedSha,
  };
}

describe("createRunContext", () => {
  it("places corpus repositories under corpus/.repos/<name>", async () => {
    const corpusRoot = await makeTempRoot("context");
    const context = createRunContext({ corpusRoot });

    expect(context.corpusRoot).toBe(corpusRoot);
    expect(context.reposDir).toBe(path.join(corpusRoot, ".repos"));
    expect(context.repoDir("fixture-app")).toBe(path.join(corpusRoot, ".repos", "fixture-app"));
    expect(context.logsDir("fixture-app")).toBe(path.join(corpusRoot, ".repos", ".logs", "fixture-app"));
  });
});

describe("ensureRepoCheckout", () => {
  it("clones a repository at the pinned SHA with detached HEAD", async () => {
    const source = await createFixtureRepo();
    const pinnedSha = await source.commitFile("pinned\n");
    await source.commitFile("newer\n");
    const corpusRoot = await makeTempRoot("clone");
    const context = createRunContext({ corpusRoot });

    const repoDir = await ensureRepoCheckout(entry(source.gitUrl, pinnedSha), { context });

    await expect(readFile(path.join(repoDir, "app.txt"), "utf8")).resolves.toBe("pinned\n");
    await expect(runGit(["rev-parse", "HEAD"], repoDir)).resolves.toBe(pinnedSha);
    await expect(runGitResult(["symbolic-ref", "-q", "HEAD"], repoDir)).resolves.toMatchObject({ code: 1 });
  });

  it("reuses an existing clone by fetching and checking out the new pinned SHA", async () => {
    const source = await createFixtureRepo();
    const firstSha = await source.commitFile("first\n");
    const corpusRoot = await makeTempRoot("reuse");
    const context = createRunContext({ corpusRoot });
    const repoDir = await ensureRepoCheckout(entry(source.gitUrl, firstSha), { context });
    const sentinel = path.join(repoDir, ".git", "corpus-sentinel");
    await writeFile(sentinel, "preserved");

    const secondSha = await source.commitFile("second\n");
    await ensureRepoCheckout(entry(source.gitUrl, secondSha), { context });

    await expect(readFile(path.join(repoDir, "app.txt"), "utf8")).resolves.toBe("second\n");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserved");
    await expect(runGit(["rev-parse", "HEAD"], repoDir)).resolves.toBe(secondSha);
  });

  it("resets dirty tracked and untracked files before returning", async () => {
    const source = await createFixtureRepo();
    const pinnedSha = await source.commitFile("clean\n");
    const corpusRoot = await makeTempRoot("dirty");
    const context = createRunContext({ corpusRoot });
    const repoDir = await ensureRepoCheckout(entry(source.gitUrl, pinnedSha), { context });
    await writeFile(path.join(repoDir, "app.txt"), "dirty\n");
    await writeFile(path.join(repoDir, "untracked.txt"), "remove me");

    await ensureRepoCheckout(entry(source.gitUrl, pinnedSha), { context });

    await expect(readFile(path.join(repoDir, "app.txt"), "utf8")).resolves.toBe("clean\n");
    await expect(runGit(["status", "--porcelain"], repoDir)).resolves.toBe("");
    await expect(readFile(path.join(repoDir, "untracked.txt"), "utf8")).rejects.toThrow();
  });

  it("recovers when the cached clone is corrupted", async () => {
    const source = await createFixtureRepo();
    const pinnedSha = await source.commitFile("restored\n");
    const corpusRoot = await makeTempRoot("corrupt");
    const context = createRunContext({ corpusRoot });
    const repoDir = await ensureRepoCheckout(entry(source.gitUrl, pinnedSha), { context });
    await rm(path.join(repoDir, ".git"), { recursive: true, force: true });
    await writeFile(path.join(repoDir, "app.txt"), "corrupt\n");

    await ensureRepoCheckout(entry(source.gitUrl, pinnedSha), { context });

    await expect(readFile(path.join(repoDir, "app.txt"), "utf8")).resolves.toBe("restored\n");
    await expect(runGit(["status", "--porcelain"], repoDir)).resolves.toBe("");
  });
});
