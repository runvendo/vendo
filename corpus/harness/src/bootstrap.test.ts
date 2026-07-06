import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo } from "./bootstrap.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";

type BootstrapRepo = Pick<ManifestEntry, "name" | "appDir" | "bootstrap">;

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-bootstrap-"));
  tempRoots.push(root);
  return root;
}

async function makeRepo(name = "fixture-app"): Promise<{
  repo: BootstrapRepo;
  repoDir: string;
  corpusRoot: string;
}> {
  const corpusRoot = await makeTempRoot();
  const context = createRunContext({ corpusRoot });
  const repoDir = context.repoDir(name);
  await mkdir(repoDir, { recursive: true });

  return {
    corpusRoot,
    repoDir,
    repo: {
      name,
      bootstrap: {
        installCommand: `${JSON.stringify(process.execPath)} install.mjs`,
        envTemplate: {},
        buildCommand: "npm run build",
      },
    },
  };
}

async function writeInstallScript(repoDir: string, body: string): Promise<void> {
  await writeFile(path.join(repoDir, "install.mjs"), body);
}

describe("bootstrapRepo", () => {
  it("runs the install command in the corpus repo directory and captures command logs", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    await writeInstallScript(repoDir, `
      import { writeFileSync } from "node:fs";
      console.log("install stdout");
      console.error("install stderr");
      writeFileSync("installed-cwd.txt", process.cwd());
    `);

    await bootstrapRepo(repo, { context });

    const installedCwd = await readFile(path.join(repoDir, "installed-cwd.txt"), "utf8");
    expect(await realpath(installedCwd)).toBe(await realpath(repoDir));
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stdout.log"), "utf8")).resolves.toContain("install stdout");
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stderr.log"), "utf8")).resolves.toContain("install stderr");
    await expect(readFile(path.join(repoDir, ".corpus", "logs", "bootstrap.stdout.log"), "utf8")).rejects.toThrow();
  });

  it("materializes .env from envTemplate placeholders and literal values", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    repo.bootstrap.envTemplate = {
      DATABASE_URL: "${CORPUS_FIXTURE_DATABASE_URL}",
      NEXT_PUBLIC_BASE_URL: "https://${CORPUS_FIXTURE_HOST}/app",
      STATIC_FLAG: "enabled",
    };
    await writeInstallScript(repoDir, `console.log("ok");`);

    await bootstrapRepo(repo, {
      context: createRunContext({ corpusRoot }),
      env: {
        CORPUS_FIXTURE_DATABASE_URL: "postgres://user:pass@localhost:5432/app",
        CORPUS_FIXTURE_HOST: "example.test",
      },
    });

    await expect(readFile(path.join(repoDir, ".env"), "utf8")).resolves.toBe([
      "DATABASE_URL=postgres://user:pass@localhost:5432/app",
      "NEXT_PUBLIC_BASE_URL=https://example.test/app",
      "STATIC_FLAG=enabled",
      "",
    ].join("\n"));
  });

  it("writes .env in appDir while running install from the checkout root", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    repo.appDir = "apps/web";
    repo.bootstrap.envTemplate = {
      NEXT_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
    };
    const appRoot = path.join(repoDir, repo.appDir);
    await mkdir(appRoot, { recursive: true });
    await writeInstallScript(repoDir, `
      import { writeFileSync } from "node:fs";
      writeFileSync("installed-cwd.txt", process.cwd());
    `);

    const result = await bootstrapRepo(repo, {
      context: createRunContext({ corpusRoot }),
    });

    expect(result.envPath).toBe(path.join(appRoot, ".env"));
    const installedCwd = await readFile(path.join(repoDir, "installed-cwd.txt"), "utf8");
    expect(await realpath(installedCwd)).toBe(await realpath(repoDir));
    await expect(readFile(path.join(appRoot, ".env"), "utf8")).resolves.toBe("NEXT_PUBLIC_BASE_URL=http://127.0.0.1:3000\n");
    await expect(readFile(path.join(repoDir, ".env"), "utf8")).rejects.toThrow();
  });

  it("fails before install and lists all missing placeholder variables", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    repo.bootstrap.envTemplate = {
      DATABASE_URL: "${CORPUS_FIXTURE_DATABASE_URL}",
      API_KEY: "${CORPUS_FIXTURE_API_KEY}",
    };
    await writeInstallScript(repoDir, `
      import { writeFileSync } from "node:fs";
      writeFileSync("should-not-run.txt", "ran");
    `);

    await expect(
      bootstrapRepo(repo, {
        context: createRunContext({ corpusRoot }),
        env: {},
      }),
    ).rejects.toThrow(/CORPUS_FIXTURE_API_KEY[\s\S]*CORPUS_FIXTURE_DATABASE_URL|CORPUS_FIXTURE_DATABASE_URL[\s\S]*CORPUS_FIXTURE_API_KEY/);
    await expect(readFile(path.join(repoDir, "should-not-run.txt"), "utf8")).rejects.toThrow();
  });

  it("writes stdout and stderr logs when the install command fails", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    await writeInstallScript(repoDir, `
      console.log("before failure");
      console.error("failure detail");
      process.exit(7);
    `);

    await expect(bootstrapRepo(repo, { context })).rejects.toThrow(/install command failed.*7/i);

    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stdout.log"), "utf8")).resolves.toContain("before failure");
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stderr.log"), "utf8")).resolves.toContain("failure detail");
    await expect(readFile(path.join(repoDir, ".corpus", "logs", "bootstrap.stderr.log"), "utf8")).rejects.toThrow();
  });
});
