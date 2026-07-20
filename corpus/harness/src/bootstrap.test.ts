import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrapRepo } from "./bootstrap.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";

type BootstrapRepo = Pick<ManifestEntry, "name" | "appDir" | "localPath" | "bootstrap">;

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

async function writeNodeBin(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `#!/usr/bin/env node\n${body}`);
  await chmod(file, 0o755);
}

describe("bootstrapRepo", () => {
  it("writes local-source env and logs while skipping the pre-injection install", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    repo.localPath = "corpus/hosts/fixture-app";
    repo.bootstrap.envTemplate = { PORT: "3210" };
    await writeInstallScript(repoDir, `
      import { writeFileSync } from "node:fs";
      writeFileSync("install-should-not-run.txt", "ran");
    `);

    const result = await bootstrapRepo(repo, { context });

    await expect(readFile(result.envPath, "utf8")).resolves.toBe("PORT=3210\n");
    await expect(readFile(path.join(repoDir, "install-should-not-run.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(result.logs.stdout, "utf8")).resolves.toMatch(/skipped pre-injection install/i);
    await expect(readFile(result.logs.stderr, "utf8")).resolves.toBe("");
  });

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

  it("degrades frozen pnpm install recipes and records the normalized command in logs", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    const binDir = path.join(corpusRoot, "bin");
    repo.bootstrap.installCommand = "pnpm install --frozen-lockfile --force --ignore-workspace";
    await writeNodeBin(path.join(binDir, "pnpm"), `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(path.join(repoDir, "pnpm-argv.txt"))}, process.argv.slice(2).join(" "));
      console.log("fake pnpm install");
    `);

    await bootstrapRepo(repo, {
      context,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await expect(readFile(path.join(repoDir, "pnpm-argv.txt"), "utf8")).resolves.toBe(
      "--config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force --ignore-workspace",
    );
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stdout.log"), "utf8")).resolves.toMatch(/normalized.*--no-frozen-lockfile/i);
  });

  it("drops --ignore-workspace for pnpm workspace bootstrap installs", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    const binDir = path.join(corpusRoot, "bin");
    repo.bootstrap.installCommand = "pnpm install --frozen-lockfile --force --ignore-workspace";
    await writeFile(path.join(repoDir, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    await writeNodeBin(path.join(binDir, "pnpm"), `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(path.join(repoDir, "pnpm-workspace-argv.txt"))}, process.argv.slice(2).join(" "));
      console.log("fake pnpm workspace install");
    `);

    await bootstrapRepo(repo, {
      context,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await expect(readFile(path.join(repoDir, "pnpm-workspace-argv.txt"), "utf8")).resolves.toBe(
      "--config.minimumReleaseAge=0 --config.dangerouslyAllowAllBuilds=true install --no-frozen-lockfile --force",
    );
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stdout.log"), "utf8")).resolves.toMatch(/normalized.*--no-frozen-lockfile --force/i);
  });

  it("omits dangerouslyAllowAllBuilds when pnpm-workspace.yaml declares onlyBuiltDependencies", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    const binDir = path.join(corpusRoot, "bin");
    repo.bootstrap.installCommand = "pnpm install --frozen-lockfile --force --ignore-workspace";
    await writeFile(
      path.join(repoDir, "pnpm-workspace.yaml"),
      "packages:\n  - '.'\nonlyBuiltDependencies:\n  - prisma\n",
    );
    await writeNodeBin(path.join(binDir, "pnpm"), `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(path.join(repoDir, "pnpm-curated-argv.txt"))}, process.argv.slice(2).join(" "));
      console.log("fake pnpm curated-builds install");
    `);

    await bootstrapRepo(repo, {
      context,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await expect(readFile(path.join(repoDir, "pnpm-curated-argv.txt"), "utf8")).resolves.toBe(
      "--config.minimumReleaseAge=0 install --no-frozen-lockfile --force",
    );
  });

  it("omits dangerouslyAllowAllBuilds when package.json's pnpm field declares neverBuiltDependencies", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    const binDir = path.join(corpusRoot, "bin");
    repo.bootstrap.installCommand = "pnpm install --frozen-lockfile --force --ignore-workspace";
    await writeFile(
      path.join(repoDir, "package.json"),
      `${JSON.stringify({ name: "fixture-app", pnpm: { neverBuiltDependencies: ["esbuild"] } }, null, 2)}\n`,
    );
    await writeNodeBin(path.join(binDir, "pnpm"), `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(path.join(repoDir, "pnpm-never-argv.txt"))}, process.argv.slice(2).join(" "));
      console.log("fake pnpm never-built-deps install");
    `);

    await bootstrapRepo(repo, {
      context,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await expect(readFile(path.join(repoDir, "pnpm-never-argv.txt"), "utf8")).resolves.toBe(
      "--config.minimumReleaseAge=0 install --no-frozen-lockfile --force --ignore-workspace",
    );
  });

  it("degrades npm ci bootstrap recipes to npm install", async () => {
    const { corpusRoot, repo, repoDir } = await makeRepo();
    const context = createRunContext({ corpusRoot });
    const binDir = path.join(corpusRoot, "bin");
    repo.bootstrap.installCommand = "npm ci";
    await writeNodeBin(path.join(binDir, "npm"), `
      const { writeFileSync } = await import("node:fs");
      writeFileSync(${JSON.stringify(path.join(repoDir, "npm-argv.txt"))}, process.argv.slice(2).join(" "));
      console.log("fake npm install");
    `);

    await bootstrapRepo(repo, {
      context,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
    });

    await expect(readFile(path.join(repoDir, "npm-argv.txt"), "utf8")).resolves.toBe("install");
    await expect(readFile(path.join(context.logsDir(repo.name), "bootstrap.stdout.log"), "utf8")).resolves.toMatch(/normalized.*npm install/i);
  });
});
