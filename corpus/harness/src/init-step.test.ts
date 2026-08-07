import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runVendoInitStep } from "./init-step.js";
import { createRunContext } from "./run-context.js";

const fixtureDir = fileURLToPath(new URL("../test/fixtures/minimal-next-app/", import.meta.url));
const tempRoots: string[] = [];

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

function run(command: string, args: readonly string[], cwd: string): Promise<CommandResult> {
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

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-init-"));
  tempRoots.push(root);
  return root;
}

async function copyFixtureRepo(context: ReturnType<typeof createRunContext>, appDir?: string): Promise<string> {
  const repoDir = context.repoDir("fixture-next-app");
  const appRoot = appDir ? path.join(repoDir, appDir) : repoDir;
  await mkdir(path.dirname(appRoot), { recursive: true });
  await cp(fixtureDir, appRoot, { recursive: true });
  await runGit(["init"], repoDir);
  await runGit(["checkout", "-b", "main"], repoDir);
  await runGit(["config", "user.email", "corpus@example.com"], repoDir);
  await runGit(["config", "user.name", "Corpus Test"], repoDir);
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "-m", "fixture"], repoDir);
  return repoDir;
}

async function writeFakeVendoCli(root: string): Promise<string> {
  const file = path.join(root, "fake-vendo-init.mjs");
  await writeFile(file, `
    import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";

    const args = process.argv.slice(2);
    console.log("fake init stdout");
    console.error("fake init stderr");
    console.log("args:" + JSON.stringify(args));

    if (args[0] !== "init") process.exit(2);
    const targetDir = args[1];
    if (!targetDir) process.exit(3);
    if (!args.includes("--yes")) process.exit(4);

    mkdirSync(path.join(targetDir, ".vendo"), { recursive: true });
    writeFileSync(path.join(targetDir, ".vendo", "theme.json"), JSON.stringify({ version: 1, accent: "#0a7cff" }, null, 2) + "\\n");
    if (process.env.EXTRA_FILE) {
      writeFileSync(path.join(targetDir, process.env.EXTRA_FILE), "extra file\\n");
    }
    if (process.env.WRITE_VENDOR_TARBALL) {
      mkdirSync(path.join(targetDir, "vendor"), { recursive: true });
      writeFileSync(path.join(targetDir, "vendor", "vendoai-vendo-0.3.0.tgz"), process.env.WRITE_VENDOR_TARBALL);
    }

    const pkgPath = path.join(targetDir, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies = { ...pkg.dependencies, "@vendoai/vendo": "file:vendor/vendoai-vendo-0.3.0.tgz" };
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\\n");

    if (process.env.FAIL_INIT === "1") {
      writeFileSync(path.join(targetDir, "failed-init.txt"), "left behind for diff\\n");
      console.log("tokens: 12 cost: $0.00");
      process.exit(7);
    }

    console.log("tokens: 12 cost: $0.00");
  `);
  return file;
}

describe("runVendoInitStep", () => {
  it("runs init non-interactively and captures log, duration, token/cost line, and post-init diff", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app" };
    const repoDir = await copyFixtureRepo(context);
    const fakeCli = await writeFakeVendoCli(corpusRoot);

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      force: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.repoDir).toBe(repoDir);
    expect(result.artifacts.log.startsWith(context.logsDir(repo.name))).toBe(true);
    expect(result.artifacts.log.startsWith(repoDir)).toBe(false);

    const log = await readFile(result.artifacts.log, "utf8");
    expect(log).toContain("fake init stdout");
    expect(log).toContain("fake init stderr");
    expect(log).toContain(`"init","${repoDir}","--yes","--force"`);

    const tokenCost = await readFile(result.artifacts.tokenCost!, "utf8");
    expect(tokenCost).toContain("tokens: 12 cost: $0.00");

    const diff = await readFile(result.artifacts.diff, "utf8");
    expect(diff).toContain("diff --git a/.vendo/theme.json b/.vendo/theme.json");
    expect(diff).toContain('+    "@vendoai/vendo": "file:vendor/vendoai-vendo-0.3.0.tgz"');
    await expect(readFile(path.join(repoDir, ".corpus/logs/init.log"), "utf8")).rejects.toThrow();
  });

  it("runs init in appDir and can diff a second run against the post-first-init snapshot", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app", appDir: "apps/web" };
    const checkoutDir = await copyFixtureRepo(context, repo.appDir);
    const appRoot = path.join(checkoutDir, repo.appDir);
    const fakeCli = await writeFakeVendoCli(corpusRoot);

    await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      artifactPrefix: "init.first",
    });

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      artifactPrefix: "init.second",
      diffBase: "pre-run",
      env: { EXTRA_FILE: "second-only.txt" },
    });

    expect(result.repoDir).toBe(appRoot);
    const log = await readFile(result.artifacts.log, "utf8");
    expect(log).toContain(`"init","${appRoot}","--yes"`);

    const diff = await readFile(result.artifacts.diff, "utf8");
    expect(diff).toContain("diff --git a/apps/web/second-only.txt b/apps/web/second-only.txt");
    expect(diff).not.toContain("apps/web/.vendo/theme.json");
    expect(diff).not.toContain("apps/web/package.json");
  });

  it("ignores regenerated vendor tarballs in the second-run idempotency diff", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app" };
    await copyFixtureRepo(context);
    const fakeCli = await writeFakeVendoCli(corpusRoot);

    await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      artifactPrefix: "init.first",
      env: { WRITE_VENDOR_TARBALL: "first bytes" },
    });

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      artifactPrefix: "init.second",
      diffBase: "pre-run",
      env: { WRITE_VENDOR_TARBALL: "second bytes" },
    });

    await expect(readFile(result.artifacts.diff, "utf8")).resolves.toBe("");
  });

  it("appends --ai-polish when the aiPolish option is set", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app" };
    const repoDir = await copyFixtureRepo(context);
    const fakeCli = await writeFakeVendoCli(corpusRoot);

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      aiPolish: true,
    });

    const log = await readFile(result.artifacts.log, "utf8");
    expect(log).toContain(`"init","${repoDir}","--yes","--ai-polish"`);
  });

  it("omits --ai-polish when the option is unset", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app" };
    const repoDir = await copyFixtureRepo(context);
    const fakeCli = await writeFakeVendoCli(corpusRoot);

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
    });

    const log = await readFile(result.artifacts.log, "utf8");
    expect(log).toContain(`"init","${repoDir}","--yes"`);
    expect(log).not.toContain("--ai-polish");
  });

  it("returns a nonzero init exit code while still writing log and diff artifacts", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { name: "fixture-next-app" };
    const fakeCli = await writeFakeVendoCli(corpusRoot);
    await copyFixtureRepo(context);

    const result = await runVendoInitStep(repo, {
      context,
      cliCommand: process.execPath,
      cliArgs: [fakeCli],
      env: { FAIL_INIT: "1" },
    });

    expect(result.exitCode).toBe(7);
    await expect(readFile(result.artifacts.log, "utf8")).resolves.toContain("fake init stderr");
    await expect(readFile(result.artifacts.diff, "utf8")).resolves.toContain("diff --git a/failed-init.txt b/failed-init.txt");
  });
});
