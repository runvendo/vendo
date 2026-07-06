import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootRepo, type BootProcess } from "./boot.js";
import { createRunContext } from "./run-context.js";
import type { ManifestEntry } from "./manifest.js";

const tempRoots: string[] = [];
const validSha = "0123456789abcdef0123456789abcdef01234567";
type FakeBootProcess = BootProcess & { stdout: PassThrough; stderr: PassThrough };

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "vendo-corpus-boot-"));
  tempRoots.push(root);
  return root;
}

function repoEntry(name = "umami"): ManifestEntry {
  return {
    name,
    gitUrl: `https://example.com/${name}.git`,
    pinnedSha: validSha,
    license: "MIT",
    tier: "deep",
    bootstrap: {
      installCommand: "pnpm install --frozen-lockfile",
      envTemplate: {},
      seedCommand: "pnpm seed-data",
      database: {
        kind: "docker-postgres",
        containerName: `vendo-corpus-${name}-postgres`,
        image: "postgres:16-alpine",
        hostPort: 55432,
        database: name,
        username: "corpus",
        password: "corpus",
      },
      buildCommand: "pnpm build",
      devServer: {
        command: "pnpm dev",
        readinessUrl: "http://127.0.0.1:3000",
        readinessTimeoutMs: 1_000,
      },
    },
  };
}

function fakeProcess(pid: number): FakeBootProcess {
  return {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill() {
      return true;
    },
  };
}

describe("bootRepo", () => {
  it("provisions DB, runs seed, starts the dev server, polls readiness, captures logs outside the repo tree, and tears down", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = repoEntry();
    const repoDir = context.repoDir(repo.name);
    await mkdir(repoDir, { recursive: true });
    const events: string[] = [];
    const server = fakeProcess(1234);

    const boot = await bootRepo(repo, {
      context,
      provisionDatabase: async (database) => {
        events.push(`db:start:${database.containerName}`);
        return { teardown: async () => { events.push(`db:stop:${database.containerName}`); } };
      },
      runCommand: async (command, options) => {
        events.push(`seed:${command}:${options.cwd}`);
        return { code: 0, signal: null, stdout: "seeded\n", stderr: "" };
      },
      spawnProcess: (command, options) => {
        events.push(`server:${command}:${options.cwd}`);
        return server;
      },
      checkReadiness: async (url) => {
        events.push(`ready:${url}`);
        server.stdout.write("ready stdout\n");
        server.stderr.write("ready stderr\n");
        return true;
      },
      killProcessTree: async (pid) => { events.push(`kill:${pid}`); },
      sleep: async () => {},
    });

    await boot.teardown();

    expect(events).toEqual([
      "db:start:vendo-corpus-umami-postgres",
      `seed:pnpm seed-data:${repoDir}`,
      `server:pnpm dev:${repoDir}`,
      "ready:http://127.0.0.1:3000",
      "kill:1234",
      "db:stop:vendo-corpus-umami-postgres",
    ]);
    expect(boot.logPaths.server).toBe(path.join(context.logsDir(repo.name), "boot.server.log"));
    expect(boot.logPaths.seed).toBe(path.join(context.logsDir(repo.name), "boot.seed.log"));
    if (!boot.logPaths.seed) throw new Error("expected a seed log path");
    await expect(readFile(boot.logPaths.server, "utf8")).resolves.toContain("ready stdout");
    await expect(readFile(boot.logPaths.server, "utf8")).resolves.toContain("ready stderr");
    await expect(readFile(boot.logPaths.seed, "utf8")).resolves.toContain("seeded");
    await expect(readFile(path.join(repoDir, ".corpus", "logs", "boot.server.log"), "utf8")).rejects.toThrow();
  });

  it("kills the server process tree and provisioned DB when readiness fails, and reports recent logs", async () => {
    const corpusRoot = await makeTempRoot();
    const context = createRunContext({ corpusRoot });
    const repo = repoEntry();
    await mkdir(context.repoDir(repo.name), { recursive: true });
    const events: string[] = [];
    const server = fakeProcess(4567);

    await expect(bootRepo(repo, {
      context,
      provisionDatabase: async () => ({ teardown: async () => { events.push("db:stop"); } }),
      runCommand: async () => ({ code: 0, signal: null, stdout: "", stderr: "" }),
      spawnProcess: () => server,
      killProcessTree: async (pid) => { events.push(`kill:${pid}`); },
      checkReadiness: async () => {
        if (!events.includes("wrote-server-lines")) {
          events.push("wrote-server-lines");
          for (let index = 1; index <= 8; index += 1) {
            server.stdout.write(`line ${index}\n`);
          }
        }
        return false;
      },
      sleep: async () => {},
      lastLogLines: 3,
    })).rejects.toThrow(/line 6[\s\S]*line 7[\s\S]*line 8/);

    expect(events).toEqual(["wrote-server-lines", "kill:4567", "db:stop"]);
  });

  it("fails when boot is requested for an entry without a dev server recipe", async () => {
    const corpusRoot = await makeTempRoot();
    const repo = repoEntry();
    delete repo.bootstrap.devServer;

    await expect(bootRepo(repo, {
      context: createRunContext({ corpusRoot }),
    })).rejects.toThrow(/does not define a devServer/i);
  });
});
