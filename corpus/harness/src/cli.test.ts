import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CorpusCliDependencies } from "./cli.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";
import type { InitStepResult, RunVendoInitStepOptions } from "./init-step.js";
import type { StructuralLayerContext } from "./layers/structural.js";

const tempRoots: string[] = [];
const validSha = "0123456789abcdef0123456789abcdef01234567";
const workspaceRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-cli-"));
  tempRoots.push(root);
  return root;
}

function manifestEntry(name: string): ManifestEntry {
  return {
    name,
    gitUrl: `https://example.com/${name}.git`,
    pinnedSha: validSha,
    license: "MIT",
    tier: "broad",
    bootstrap: {
      installCommand: "pnpm install --frozen-lockfile",
      envTemplate: {},
      buildCommand: "pnpm build",
    },
  };
}

async function writeHostPackage(repoDir: string): Promise<void> {
  await mkdir(repoDir, { recursive: true });
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      {
        packageManager: "pnpm@9.12.0",
        scripts: {
          typecheck: "tsc --noEmit",
          build: "next build",
        },
      },
      null,
      2,
    ) + "\n",
  );
}

function makeInitResult(repoDir: string, log: string, diff: string, exitCode = 0): InitStepResult {
  return {
    repoDir,
    exitCode,
    signal: null,
    durationMs: 3,
    artifacts: {
      log,
      diff,
    },
  };
}

describe("runCli run", () => {
  it("chains clone, bootstrap, inject, two real init runs, and Layer 1 for each selected repo", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = manifestEntry("repo-one");
    const events: string[] = [];
    const initOptions: RunVendoInitStepOptions[] = [];
    const structuralContexts: StructuralLayerContext[] = [];
    const stdout: string[] = [];
    const injectorOptions: unknown[] = [];

    const deps: CorpusCliDependencies = {
      now: () => new Date("2026-07-05T12:00:00.000Z"),
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        events.push(`clone:${entry.name}`);
        const repoDir = context.repoDir(entry.name);
        await writeHostPackage(repoDir);
        return repoDir;
      },
      bootstrapRepo: async (entry) => {
        events.push(`bootstrap:${entry.name}`);
        return {
          repoDir: context.repoDir(entry.name),
          envPath: path.join(context.repoDir(entry.name), ".env"),
          logs: {
            stdout: path.join(context.logsDir(entry.name), "bootstrap.stdout.log"),
            stderr: path.join(context.logsDir(entry.name), "bootstrap.stderr.log"),
          },
        };
      },
      createInjector: (options) => {
        injectorOptions.push(options);
        return {
          initArgs: () => ["--local", "/workspace/vendo"],
          async inject(entry) {
            events.push(`inject:${entry.name}`);
            return {
              repoDir: context.repoDir(entry.name),
              packageManager: "pnpm",
              packages: ["@vendoai/core", "@vendoai/next", "@vendoai/shell"],
              vendorDir: path.join(context.repoDir(entry.name), "vendor"),
              installCommand: "pnpm install",
              initArgs: ["--local", "/workspace/vendo"],
            };
          },
        };
      },
      runInit: async (entry, options) => {
        initOptions.push(options ?? {});
        const ordinal = initOptions.length;
        events.push(`init${ordinal}:${entry.name}`);
        const logsDir = context.logsDir(entry.name);
        await mkdir(logsDir, { recursive: true });
        const log = path.join(logsDir, `init-${ordinal}.log`);
        const diff = path.join(logsDir, `init-${ordinal}.diff`);
        await writeFile(log, `init ${ordinal} log`);
        await writeFile(diff, ordinal === 1 ? "first diff" : "");
        return makeInitResult(context.repoDir(entry.name), log, diff);
      },
      runStructuralLayer: async (layerContext) => {
        events.push("layer1:repo-one");
        structuralContexts.push(layerContext);
        return [
          { id: "init.exit", pass: true, detail: "ok" },
          { id: "host.typecheck", pass: true, detail: "ok" },
          { id: "host.build", pass: true, detail: "ok" },
          { id: "init.idempotent", pass: true, detail: "ok" },
        ];
      },
    };

    const exitCode = await runCli(["run", "repo-one", "--layer", "1"], deps);

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "clone:repo-one",
      "bootstrap:repo-one",
      "inject:repo-one",
      "init1:repo-one",
      "init2:repo-one",
      "layer1:repo-one",
    ]);
    expect(initOptions).toHaveLength(2);
    expect(initOptions.every((options) => options.skipLlm === false)).toBe(true);
    expect(initOptions.every((options) => options.localVendoDir === "/workspace/vendo")).toBe(true);
    expect(initOptions.map((options) => options.artifactPrefix)).toEqual(["init.first", "init.second"]);
    expect(injectorOptions).toEqual([{ context, workspaceRoot }]);
    expect(structuralContexts[0]).toMatchObject({
      repoDir: context.repoDir("repo-one"),
      initExitCode: 0,
      secondInitExitCode: 0,
      secondRunDiff: "",
      typecheckCommand: "pnpm typecheck",
      buildCommand: "pnpm build",
    });
    expect(stdout.join("\n")).toContain("| repo-one | Layer 1 structural | PASS | 4/4 |");
    await expect(readFile(path.join(context.reposDir, ".logs", "scorecard.json"), "utf8")).resolves.toContain("\"repo\": \"repo-one\"");
    await expect(readFile(path.join(context.repoDir("repo-one"), "run", "scorecard.json"), "utf8")).resolves.toContain("\"repo\": \"repo-one\"");
  });

  it("uses --skip-llm only when requested and can print JSON to stdout", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = manifestEntry("repo-json");
    const skipLlmValues: Array<boolean | undefined> = [];
    const stdout: string[] = [];
    const deps: CorpusCliDependencies = {
      now: () => new Date("2026-07-05T12:00:00.000Z"),
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        await writeHostPackage(context.repoDir(entry.name));
        return context.repoDir(entry.name);
      },
      bootstrapRepo: async (entry) => ({
        repoDir: context.repoDir(entry.name),
        envPath: path.join(context.repoDir(entry.name), ".env"),
        logs: { stdout: "bootstrap.stdout.log", stderr: "bootstrap.stderr.log" },
      }),
      createInjector: () => ({
        initArgs: () => ["--local", "/workspace/vendo"],
        async inject(entry) {
          return {
            repoDir: context.repoDir(entry.name),
            packageManager: "pnpm",
            packages: [],
            vendorDir: path.join(context.repoDir(entry.name), "vendor"),
            installCommand: "pnpm install",
            initArgs: ["--local", "/workspace/vendo"],
          };
        },
      }),
      runInit: async (entry, options) => {
        skipLlmValues.push(options?.skipLlm);
        const logsDir = context.logsDir(entry.name);
        await mkdir(logsDir, { recursive: true });
        const log = path.join(logsDir, `init-${skipLlmValues.length}.log`);
        const diff = path.join(logsDir, `init-${skipLlmValues.length}.diff`);
        await writeFile(log, "ok");
        await writeFile(diff, "");
        return makeInitResult(context.repoDir(entry.name), log, diff);
      },
      runStructuralLayer: async () => [{ id: "init.exit", pass: true, detail: "ok" }],
    };

    const exitCode = await runCli(["run", "repo-json", "--layer", "1", "--skip-llm", "--json"], deps);

    expect(exitCode).toBe(0);
    expect(skipLlmValues).toEqual([true, true]);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      strict: false,
      repos: [{ repo: "repo-json", layers: [{ status: "pass" }] }],
    });
  });

  it("continues after a repo failure and makes only --strict return nonzero", async () => {
    async function execute(strict: boolean): Promise<{ exitCode: number; events: string[]; scorecard: string }> {
      const corpusRoot = await makeTempRoot();
      const context = createRunContext({ corpusRoot });
      const repos = [manifestEntry("repo-fails"), manifestEntry("repo-passes")];
      const events: string[] = [];
      const args = ["run", "--layer", "1"];
      if (strict) args.push("--strict");
      const deps: CorpusCliDependencies = {
        now: () => new Date("2026-07-05T12:00:00.000Z"),
        stdout: () => {},
        stderr: () => {},
        loadManifest: async () => repos,
        createContext: () => context,
        ensureRepoCheckout: async (entry) => {
          events.push(`clone:${entry.name}`);
          if (entry.name === "repo-fails") throw new Error("clone exploded");
          await writeHostPackage(context.repoDir(entry.name));
          return context.repoDir(entry.name);
        },
        bootstrapRepo: async (entry) => {
          events.push(`bootstrap:${entry.name}`);
          return {
            repoDir: context.repoDir(entry.name),
            envPath: path.join(context.repoDir(entry.name), ".env"),
            logs: { stdout: "bootstrap.stdout.log", stderr: "bootstrap.stderr.log" },
          };
        },
        createInjector: () => ({
          initArgs: () => ["--local", "/workspace/vendo"],
          async inject(entry) {
            events.push(`inject:${entry.name}`);
            return {
              repoDir: context.repoDir(entry.name),
              packageManager: "pnpm",
              packages: [],
              vendorDir: path.join(context.repoDir(entry.name), "vendor"),
              installCommand: "pnpm install",
              initArgs: ["--local", "/workspace/vendo"],
            };
          },
        }),
        runInit: async (entry) => {
          events.push(`init:${entry.name}`);
          const logsDir = context.logsDir(entry.name);
          await mkdir(logsDir, { recursive: true });
          const log = path.join(logsDir, "init.log");
          const diff = path.join(logsDir, "init.diff");
          await writeFile(log, "ok");
          await writeFile(diff, "");
          return makeInitResult(context.repoDir(entry.name), log, diff);
        },
        runStructuralLayer: async () => [{ id: "init.exit", pass: true, detail: "ok" }],
      };

      const exitCode = await runCli(args, deps);
      return {
        exitCode,
        events,
        scorecard: await readFile(path.join(context.reposDir, ".logs", "scorecard.json"), "utf8"),
      };
    }

    const defaultRun = await execute(false);
    const strictRun = await execute(true);

    expect(defaultRun.exitCode).toBe(0);
    expect(strictRun.exitCode).toBe(1);
    expect(defaultRun.events).toEqual([
      "clone:repo-fails",
      "clone:repo-passes",
      "bootstrap:repo-passes",
      "inject:repo-passes",
      "init:repo-passes",
      "init:repo-passes",
    ]);
    expect(defaultRun.scorecard).toContain("clone exploded");
    expect(defaultRun.scorecard).toContain("\"repo\": \"repo-passes\"");
  });
});
