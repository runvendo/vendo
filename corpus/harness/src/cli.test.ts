import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runCli, type CorpusCliDependencies } from "./cli.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";
import type { InitStepResult, RunVendoInitStepOptions } from "./init-step.js";
import type { E2eLayerContext, E2eLayerRunResult } from "./layers/e2e.js";
import type { ScoredLayerContext, ScoredLayerRunResult } from "./layers/scored.js";
import type { StructuralLayerContext } from "./layers/structural.js";
import type { BootHandle, BootRepoOptions } from "./boot.js";

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

function deepManifestEntry(name: string): ManifestEntry {
  return {
    ...manifestEntry(name),
    tier: "deep",
    bootstrap: {
      ...manifestEntry(name).bootstrap,
      devServer: {
        command: "pnpm dev",
        readinessUrl: "http://127.0.0.1:3000",
      },
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
      commandRunner: async (command, commandOptions) => {
        events.push(`baseline:${command}`);
        return {
          code: command.includes("typecheck") ? 1 : 0,
          signal: null,
          stdout: `${command} stdout @ ${commandOptions.cwd}`,
          stderr: command.includes("typecheck") ? "pre-existing type error" : "",
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
      "baseline:pnpm typecheck",
      "baseline:pnpm build",
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
    expect(structuralContexts[0]?.baseline).toMatchObject({
      typecheck: {
        command: "pnpm typecheck",
        result: { code: 1, stderr: "pre-existing type error" },
      },
      build: {
        command: "pnpm build",
        result: { code: 0 },
      },
    });
    expect(stdout.join("\n")).toContain("| repo-one | Layer 1 structural | PASS | 4/4 |");
    await expect(readFile(path.join(context.reposDir, ".logs", "scorecard.json"), "utf8")).resolves.toContain("\"repo\": \"repo-one\"");
    await expect(readFile(path.join(context.repoDir("repo-one"), "run", "scorecard.json"), "utf8")).resolves.toContain("\"repo\": \"repo-one\"");
  });

  it("uses appDir as the app root for baseline commands, init idempotency, and layer contexts", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = { ...manifestEntry("repo-app"), appDir: "apps/web" };
    const appRoot = path.join(context.repoDir(repo.name), repo.appDir);
    const initOptions: RunVendoInitStepOptions[] = [];
    const structuralContexts: StructuralLayerContext[] = [];
    const scoredContexts: ScoredLayerContext[] = [];
    const events: string[] = [];

    const exitCode = await runCli(["run", "repo-app", "--layer", "2"], {
      stdout: () => {},
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        events.push(`clone:${entry.name}`);
        await writeHostPackage(appRoot);
        return context.repoDir(entry.name);
      },
      bootstrapRepo: async (entry) => {
        events.push(`bootstrap:${entry.name}`);
        return {
          repoDir: context.repoDir(entry.name),
          envPath: path.join(appRoot, ".env"),
          logs: {
            stdout: path.join(context.logsDir(entry.name), "bootstrap.stdout.log"),
            stderr: path.join(context.logsDir(entry.name), "bootstrap.stderr.log"),
          },
        };
      },
      createInjector: () => ({
        initArgs: () => ["--local", "/workspace/vendo"],
        async inject(entry) {
          events.push(`inject:${entry.name}:${entry.appDir}`);
          return {
            repoDir: appRoot,
            packageManager: "pnpm",
            packages: [],
            vendorDir: path.join(appRoot, "vendor"),
            installCommand: "pnpm install",
            initArgs: ["--local", "/workspace/vendo"],
          };
        },
      }),
      commandRunner: async (command, commandOptions) => {
        events.push(`baseline:${command}:${commandOptions.cwd}`);
        return { code: 0, signal: null, stdout: "ok", stderr: "" };
      },
      runInit: async (entry, options) => {
        events.push(`init:${entry.name}:${entry.appDir}:${options?.diffBase ?? "head"}`);
        initOptions.push(options ?? {});
        const logsDir = context.logsDir(entry.name);
        await mkdir(logsDir, { recursive: true });
        const log = path.join(logsDir, `${initOptions.length}.log`);
        const diff = path.join(logsDir, `${initOptions.length}.diff`);
        await writeFile(log, "ok");
        await writeFile(diff, "");
        return makeInitResult(appRoot, log, diff);
      },
      runStructuralLayer: async (layerContext) => {
        structuralContexts.push(layerContext);
        return [{ id: "init.exit", pass: true, detail: "ok" }];
      },
      runScoredLayer: async (layerContext) => {
        scoredContexts.push(layerContext);
        return {
          layer: {
            layer: 2,
            name: "scored",
            status: "pass",
            checks: [],
            hardFailure: false,
          },
        };
      },
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "clone:repo-app",
      "bootstrap:repo-app",
      "inject:repo-app:apps/web",
      `baseline:pnpm typecheck:${appRoot}`,
      `baseline:pnpm build:${appRoot}`,
      "init:repo-app:apps/web:head",
      "init:repo-app:apps/web:pre-run",
    ]);
    expect(initOptions.map((options) => options.artifactPrefix)).toEqual(["init.first", "init.second"]);
    expect(initOptions.map((options) => options.diffBase)).toEqual([undefined, "pre-run"]);
    expect(structuralContexts[0]?.repoDir).toBe(appRoot);
    expect(scoredContexts[0]?.repoDir).toBe(appRoot);
  });

  it("uses --skip-llm when requested, keeps Papermark init deterministic, and can print JSON", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = manifestEntry("repo-json");
    const papermarkRepo = manifestEntry("papermark");
    const skipLlmValues: Array<boolean | undefined> = [];
    const stdout: string[] = [];
    const deps: CorpusCliDependencies = {
      now: () => new Date("2026-07-05T12:00:00.000Z"),
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo, papermarkRepo],
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
      commandRunner: async () => ({ code: 0, signal: null, stdout: "ok", stderr: "" }),
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

    skipLlmValues.length = 0;
    stdout.length = 0;
    const papermarkExitCode = await runCli(["run", "papermark", "--layer", "1"], deps);

    expect(papermarkExitCode).toBe(0);
    expect(skipLlmValues).toEqual([true, true]);
  });

  it("runs Layer 1 then Layer 2 and prints baseline update candidates", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = manifestEntry("repo-one");
    const events: string[] = [];
    const scoredContexts: ScoredLayerContext[] = [];
    const stdout: string[] = [];
    const deps: CorpusCliDependencies = {
      now: () => new Date("2026-07-06T12:00:00.000Z"),
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        events.push(`clone:${entry.name}`);
        await writeHostPackage(context.repoDir(entry.name));
        return context.repoDir(entry.name);
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
      commandRunner: async (command) => {
        events.push(`baseline:${command}`);
        return { code: 0, signal: null, stdout: "ok", stderr: "" };
      },
      runInit: async (entry) => {
        events.push(`init:${entry.name}`);
        const logsDir = context.logsDir(entry.name);
        await mkdir(logsDir, { recursive: true });
        const log = path.join(logsDir, `${events.filter((event) => event === `init:${entry.name}`).length}.log`);
        const diff = path.join(logsDir, `${events.filter((event) => event === `init:${entry.name}`).length}.diff`);
        await writeFile(log, "ok");
        await writeFile(diff, "");
        return makeInitResult(context.repoDir(entry.name), log, diff);
      },
      runStructuralLayer: async () => {
        events.push("layer1:repo-one");
        return [{ id: "init.exit", pass: true, detail: "ok" }];
      },
      runScoredLayer: async (layerContext): Promise<ScoredLayerRunResult> => {
        events.push("layer2:repo-one");
        scoredContexts.push(layerContext);
        return {
          layer: {
            layer: 2,
            name: "scored",
            status: "pass",
            score: { passed: 10, total: 10, value: 1 },
            checks: [{ id: "baseline.regression", pass: true, detail: "score above baseline" }],
            hardFailure: false,
          },
          baselineUpdate: {
            path: path.join(context.corpusRoot, "expectations/repo-one/baseline.json"),
            source: "{\n  \"version\": 1,\n  \"score\": { \"value\": 1 }\n}\n",
          },
        };
      },
    };

    const exitCode = await runCli(["run", "repo-one", "--layer", "2"], deps);

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "clone:repo-one",
      "bootstrap:repo-one",
      "inject:repo-one",
      "baseline:pnpm typecheck",
      "baseline:pnpm build",
      "init:repo-one",
      "init:repo-one",
      "layer1:repo-one",
      "layer2:repo-one",
    ]);
    expect(scoredContexts[0]).toMatchObject({
      repoName: "repo-one",
      repoDir: context.repoDir("repo-one"),
      expectationsRoot: path.join(context.corpusRoot, "expectations"),
    });
    expect(stdout.join("\n")).toContain("baseline.json");
    expect(stdout.join("\n")).toContain("\"value\": 1");
    expect(stdout.join("\n")).toContain("| repo-one | Layer 2 scored | PASS | 10/10 |");
  });

  it("runs Layer 3 by booting a deep repo and passing the booted app to the e2e harness", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = deepManifestEntry("repo-e2e");
    const events: string[] = [];
    const e2eContexts: E2eLayerContext[] = [];
    const stdout: string[] = [];
    const handle: BootHandle = {
      repoDir: context.repoDir(repo.name),
      readinessUrl: "http://127.0.0.1:3333",
      logPaths: {
        server: path.join(context.logsDir(repo.name), "boot.server.log"),
        seed: path.join(context.logsDir(repo.name), "boot.seed.log"),
        database: path.join(context.logsDir(repo.name), "boot.database.log"),
      },
      teardown: async () => { events.push("teardown:repo-e2e"); },
    };
    const deps: CorpusCliDependencies = {
      now: () => new Date("2026-07-06T12:00:00.000Z"),
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        events.push(`clone:${entry.name}`);
        await writeHostPackage(context.repoDir(entry.name));
        return context.repoDir(entry.name);
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
      commandRunner: async (command) => {
        events.push(`baseline:${command}`);
        return { code: 0, signal: null, stdout: "ok", stderr: "" };
      },
      runInit: async (entry) => {
        events.push(`init:${entry.name}`);
        const logsDir = context.logsDir(entry.name);
        await mkdir(logsDir, { recursive: true });
        const log = path.join(logsDir, `${events.filter((event) => event === `init:${entry.name}`).length}.log`);
        const diff = path.join(logsDir, `${events.filter((event) => event === `init:${entry.name}`).length}.diff`);
        await writeFile(log, "ok");
        await writeFile(diff, "");
        return makeInitResult(context.repoDir(entry.name), log, diff);
      },
      runStructuralLayer: async () => {
        events.push("layer1:repo-e2e");
        return [{ id: "init.exit", pass: true, detail: "ok" }];
      },
      runScoredLayer: async () => {
        events.push("layer2:repo-e2e");
        return {
          layer: {
            layer: 2,
            name: "scored",
            status: "pass",
            score: { passed: 10, total: 10, value: 1 },
            checks: [],
            hardFailure: false,
          },
        };
      },
      bootRepo: async () => {
        events.push("boot:repo-e2e");
        return handle;
      },
      runE2eLayer: async (layerContext): Promise<E2eLayerRunResult> => {
        events.push("layer3:repo-e2e");
        e2eContexts.push(layerContext);
        return {
          layer: {
            layer: 3,
            name: "e2e",
            status: "pass",
            score: { passed: 5, total: 5, value: 1 },
            checks: [{ id: "conversation.one", pass: true, detail: "pass@2" }],
            logPaths: [path.join(context.logsDir(repo.name), "e2e.conversations.json")],
            hardFailure: false,
          },
        };
      },
    };

    const exitCode = await runCli(["run", "repo-e2e", "--layer", "3"], deps);

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "clone:repo-e2e",
      "bootstrap:repo-e2e",
      "inject:repo-e2e",
      "baseline:pnpm typecheck",
      "baseline:pnpm build",
      "init:repo-e2e",
      "init:repo-e2e",
      "layer1:repo-e2e",
      "layer2:repo-e2e",
      "boot:repo-e2e",
      "layer3:repo-e2e",
      "teardown:repo-e2e",
    ]);
    expect(e2eContexts[0]).toMatchObject({
      repoName: "repo-e2e",
      repoDir: context.repoDir("repo-e2e"),
      readinessUrl: "http://127.0.0.1:3333",
      expectationsRoot: path.join(context.corpusRoot, "expectations"),
      logsDir: context.logsDir("repo-e2e"),
    });
    expect(stdout.join("\n")).toContain("| repo-e2e | Layer 3 e2e | PASS | 5/5 |");
    expect(stdout.join("\n")).toContain("boot.server.log");
    expect(stdout.join("\n")).toContain("e2e.conversations.json");
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
        commandRunner: async () => ({ code: 0, signal: null, stdout: "ok", stderr: "" }),
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

describe("runCli boot", () => {
  it("runs clone, bootstrap, local injection, init, then boots until the shutdown waiter resolves", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = deepManifestEntry("repo-boot");
    const events: string[] = [];
    const stdout: string[] = [];
    const bootOptions: BootRepoOptions[] = [];
    const handle: BootHandle = {
      repoDir: context.repoDir(repo.name),
      readinessUrl: repo.bootstrap.devServer?.readinessUrl ?? "",
      logPaths: { server: path.join(context.logsDir(repo.name), "boot.server.log") },
      teardown: async () => { events.push("boot:teardown"); },
    };

    const exitCode = await runCli(["boot", "repo-boot"], {
      stdout: (line) => { stdout.push(line); },
      stderr: () => {},
      loadManifest: async () => [repo],
      createContext: () => context,
      ensureRepoCheckout: async (entry) => {
        events.push(`clone:${entry.name}`);
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
      runInit: async (entry, options) => {
        events.push(`init:${entry.name}:${options?.skipLlm}`);
        return makeInitResult(context.repoDir(entry.name), "init.log", "init.diff");
      },
      bootRepo: async (entry, options) => {
        events.push(`boot:${entry.name}`);
        bootOptions.push(options ?? {});
        return handle;
      },
      waitForBootShutdown: async () => { events.push("wait"); },
    });

    expect(exitCode).toBe(0);
    expect(events).toEqual([
      "clone:repo-boot",
      "bootstrap:repo-boot",
      "inject:repo-boot",
      "init:repo-boot:false",
      "boot:repo-boot",
      "wait",
      "boot:teardown",
    ]);
    expect(bootOptions[0]).toMatchObject({ context, env: undefined });
    expect(stdout.join("\n")).toContain("Booted repo-boot at http://127.0.0.1:3000");
  });
});
