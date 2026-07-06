import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import type { DatabaseProvisioning, ManifestEntry } from "./manifest.js";
import { createRunContext, type CorpusRunContext } from "./run-context.js";

export interface BootCommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface BootProcess {
  pid?: number;
  stdout?: Readable | NodeJS.ReadableStream | null;
  stderr?: Readable | NodeJS.ReadableStream | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
  once?: (event: "exit" | "close" | "error", listener: (...args: unknown[]) => void) => unknown;
}

export interface BootLogPaths {
  server: string;
  seed?: string;
  database?: string;
}

export interface BootHandle {
  repoDir: string;
  readinessUrl: string;
  logPaths: BootLogPaths;
  teardown: () => Promise<void>;
}

export interface DatabaseProvisionHandle {
  teardown?: () => Promise<void>;
}

export interface DatabaseProvisionContext {
  repo: BootRepo;
  context: CorpusRunContext;
  logsDir: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
  sleep: (ms: number) => Promise<void>;
}

export type BootRepo = Pick<ManifestEntry, "name" | "bootstrap">;
export type BootProcessSpawner = (command: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => BootProcess;
export type BootCommandRunner = (command: string, options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<BootCommandResult>;
export type ReadinessChecker = (url: string) => Promise<boolean>;
export type DatabaseProvisioner = (
  database: DatabaseProvisioning,
  context: DatabaseProvisionContext,
) => Promise<DatabaseProvisionHandle>;
export type ProcessTreeKiller = (pid: number, signal?: NodeJS.Signals) => Promise<void>;

export interface BootRepoOptions {
  context?: CorpusRunContext;
  env?: NodeJS.ProcessEnv;
  spawnProcess?: BootProcessSpawner;
  runCommand?: BootCommandRunner;
  checkReadiness?: ReadinessChecker;
  provisionDatabase?: DatabaseProvisioner;
  killProcessTree?: ProcessTreeKiller;
  sleep?: (ms: number) => Promise<void>;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  lastLogLines?: number;
}

interface BinaryResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

const defaultReadinessTimeoutMs = 60_000;
const defaultReadinessIntervalMs = 500;
const defaultLastLogLines = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function commandResultOutput(result: BinaryResult | BootCommandResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runCommand(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<BootCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function runBinary(command: string, args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<BinaryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function checkedBinary(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<BinaryResult> {
  const result = await runBinary(command, args, options);
  if (result.code !== 0) {
    const output = commandResultOutput(result);
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

async function appendDatabaseLog(logPath: string, command: string, result: BinaryResult | string): Promise<void> {
  if (typeof result === "string") {
    await appendFile(logPath, `$ ${command}\n${result}${result.endsWith("\n") ? "" : "\n"}`);
    return;
  }
  const output = commandResultOutput(result);
  await appendFile(logPath, `$ ${command}\n${output ? `${output}\n` : ""}`);
}

async function defaultProvisionDatabase(
  database: DatabaseProvisioning,
  context: DatabaseProvisionContext,
): Promise<DatabaseProvisionHandle> {
  await writeFile(context.logPath, "");
  if (database.kind !== "docker-postgres") {
    throw new Error(`Unsupported database provisioning kind: ${(database as { kind: string }).kind}`);
  }

  const dockerEnv = context.env;
  const dockerOptions = { cwd: context.context.corpusRoot, env: dockerEnv };
  const removeBefore = await runBinary("docker", ["rm", "-f", database.containerName], dockerOptions);
  await appendDatabaseLog(context.logPath, `docker rm -f ${database.containerName}`, removeBefore);

  let startedContainer = false;
  try {
    const runArgs = [
      "run",
      "-d",
      "--name",
      database.containerName,
      "-e",
      `POSTGRES_USER=${database.username}`,
      "-e",
      `POSTGRES_PASSWORD=${database.password}`,
      "-e",
      `POSTGRES_DB=${database.database}`,
      "-p",
      `127.0.0.1:${database.hostPort}:5432`,
      database.image,
    ];
    const started = await checkedBinary("docker", runArgs, dockerOptions);
    startedContainer = true;
    await appendDatabaseLog(context.logPath, `docker ${runArgs.join(" ")}`, started);

    const timeoutMs = database.readinessTimeoutMs ?? 30_000;
    const intervalMs = database.readinessIntervalMs ?? defaultReadinessIntervalMs;
    const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
    let lastResult: BinaryResult | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      lastResult = await runBinary("docker", [
        "exec",
        database.containerName,
        "pg_isready",
        "-U",
        database.username,
        "-d",
        database.database,
      ], dockerOptions);
      await appendDatabaseLog(context.logPath, "docker exec ... pg_isready", lastResult);
      if (lastResult.code === 0) {
        return {
          teardown: async () => {
            const stopped = await runBinary("docker", ["rm", "-f", database.containerName], dockerOptions);
            await appendDatabaseLog(context.logPath, `docker rm -f ${database.containerName}`, stopped);
          },
        };
      }
      await context.sleep(intervalMs);
    }

    const output = lastResult ? commandResultOutput(lastResult) : "";
    throw new Error(`Database container ${database.containerName} did not become ready within ${timeoutMs}ms${output ? `:\n${output}` : ""}`);
  } catch (error) {
    if (startedContainer) {
      const stopped = await runBinary("docker", ["rm", "-f", database.containerName], dockerOptions);
      await appendDatabaseLog(context.logPath, `docker rm -f ${database.containerName}`, stopped);
    }
    throw error;
  }
}

function defaultSpawnProcess(command: string, options: { cwd: string; env: NodeJS.ProcessEnv }): BootProcess {
  return spawn(command, {
    cwd: options.cwd,
    env: options.env,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
}

async function defaultCheckReadiness(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "manual" });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function defaultKillProcessTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const target = process.platform === "win32" ? pid : -pid;
  try {
    process.kill(target, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await sleep(750);
  try {
    process.kill(target, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

class TailBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly maxLines: number) {}

  push(chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
    for (const line of lines) {
      this.lines.push(line);
    }
    if (this.lines.length > this.maxLines) {
      this.lines.splice(0, this.lines.length - this.maxLines);
    }
  }

  text(): string {
    return this.lines.join("\n");
  }
}

function attachLogStream(
  bootProcess: BootProcess,
  logPath: string,
  tail: TailBuffer,
): () => Promise<void> {
  const writer = createWriteStream(logPath, { flags: "w" });
  const write = (chunk: unknown) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    tail.push(text);
    writer.write(text);
  };
  bootProcess.stdout?.on("data", write);
  bootProcess.stderr?.on("data", write);

  return async () => {
    const stdout = bootProcess.stdout as { off?: (event: string, listener: (chunk: unknown) => void) => void; removeListener?: (event: string, listener: (chunk: unknown) => void) => void } | null | undefined;
    const stderr = bootProcess.stderr as { off?: (event: string, listener: (chunk: unknown) => void) => void; removeListener?: (event: string, listener: (chunk: unknown) => void) => void } | null | undefined;
    if (stdout?.off) stdout.off("data", write);
    else stdout?.removeListener?.("data", write);
    if (stderr?.off) stderr.off("data", write);
    else stderr?.removeListener?.("data", write);
    await new Promise<void>((resolve, reject) => {
      writer.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
  };
}

async function runSeedCommand(
  command: string,
  repoDir: string,
  env: NodeJS.ProcessEnv,
  logPath: string,
  runner: BootCommandRunner,
): Promise<void> {
  const result = await runner(command, { cwd: repoDir, env });
  await writeFile(logPath, [result.stdout, result.stderr].filter(Boolean).join(""));
  if (result.code !== 0) {
    const detail = result.code === null ? `signal ${result.signal ?? "unknown"}` : `exit code ${result.code}`;
    throw new Error(`Seed command failed with ${detail}; see ${logPath}`);
  }
}

async function waitForReadiness(
  readinessUrl: string,
  timeoutMs: number,
  intervalMs: number,
  checkReadiness: ReadinessChecker,
  sleepFn: (ms: number) => Promise<void>,
  getProcessFailure: () => string | undefined,
): Promise<void> {
  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs));
  let lastFailure: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const processFailure = getProcessFailure();
    if (processFailure) throw new Error(processFailure);
    try {
      if (await checkReadiness(readinessUrl)) return;
    } catch (error) {
      lastFailure = error;
    }
    if (attempt < attempts - 1) {
      await sleepFn(intervalMs);
    }
  }

  const cause = lastFailure instanceof Error ? ` Last readiness error: ${lastFailure.message}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${readinessUrl}.${cause}`);
}

function formatBootFailure(repoName: string, error: unknown, tail: TailBuffer, lastLogLines: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  const recentLogs = tail.text();
  return new Error(`Boot failed for ${repoName}: ${message}${recentLogs ? `\nLast ${lastLogLines} server log lines:\n${recentLogs}` : ""}`);
}

function joinErrors(errors: readonly unknown[]): string {
  return errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
}

export async function bootRepo(repo: BootRepo, options: BootRepoOptions = {}): Promise<BootHandle> {
  const devServer = repo.bootstrap.devServer;
  if (!devServer) {
    throw new Error(`Corpus repo ${repo.name} does not define a devServer recipe.`);
  }

  const context = options.context ?? createRunContext();
  const repoDir = context.repoDir(repo.name);
  const logsDir = context.logsDir(repo.name);
  const env = { ...process.env, ...options.env };
  const sleepFn = options.sleep ?? sleep;
  const runner = options.runCommand ?? runCommand;
  const provisionDatabase = options.provisionDatabase ?? defaultProvisionDatabase;
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const checkReadiness = options.checkReadiness ?? defaultCheckReadiness;
  const killProcessTree = options.killProcessTree ?? defaultKillProcessTree;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? devServer.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
  const readinessIntervalMs = options.readinessIntervalMs ?? devServer.readinessIntervalMs ?? defaultReadinessIntervalMs;
  const lastLogLines = options.lastLogLines ?? defaultLastLogLines;
  const logPaths: BootLogPaths = {
    server: path.join(logsDir, "boot.server.log"),
  };
  if (repo.bootstrap.seedCommand) logPaths.seed = path.join(logsDir, "boot.seed.log");
  if (repo.bootstrap.database) logPaths.database = path.join(logsDir, "boot.database.log");

  await mkdir(logsDir, { recursive: true });

  let databaseHandle: DatabaseProvisionHandle | undefined;
  let serverProcess: BootProcess | undefined;
  let closeServerLog: (() => Promise<void>) | undefined;
  let serverExit: string | undefined;
  let tornDown = false;
  const tail = new TailBuffer(lastLogLines);

  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    const errors: unknown[] = [];
    if (serverProcess?.pid) {
      try {
        await killProcessTree(serverProcess.pid, "SIGTERM");
      } catch (error) {
        errors.push(error);
      }
    } else if (serverProcess?.kill) {
      try {
        serverProcess.kill("SIGTERM");
      } catch (error) {
        errors.push(error);
      }
    }
    if (closeServerLog) {
      try {
        await closeServerLog();
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await databaseHandle?.teardown?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new Error(`Boot teardown failed: ${joinErrors(errors)}`);
    }
  };

  try {
    if (repo.bootstrap.database) {
      databaseHandle = await provisionDatabase(repo.bootstrap.database, {
        repo,
        context,
        logsDir,
        logPath: logPaths.database ?? path.join(logsDir, "boot.database.log"),
        env,
        sleep: sleepFn,
      });
    }

    if (repo.bootstrap.seedCommand && logPaths.seed) {
      await runSeedCommand(repo.bootstrap.seedCommand, repoDir, env, logPaths.seed, runner);
    }

    serverProcess = spawnProcess(devServer.command, { cwd: repoDir, env });
    serverProcess.once?.("exit", (code, signal) => {
      serverExit = `Dev server exited before readiness with ${code === null ? `signal ${String(signal)}` : `exit code ${String(code)}`}`;
    });
    serverProcess.once?.("error", (error) => {
      serverExit = `Dev server failed to start: ${error instanceof Error ? error.message : String(error)}`;
    });
    closeServerLog = attachLogStream(serverProcess, logPaths.server, tail);

    await waitForReadiness(
      devServer.readinessUrl,
      readinessTimeoutMs,
      readinessIntervalMs,
      checkReadiness,
      sleepFn,
      () => serverExit,
    );

    return {
      repoDir,
      readinessUrl: devServer.readinessUrl,
      logPaths,
      teardown,
    };
  } catch (error) {
    let teardownError: unknown;
    try {
      await teardown();
    } catch (caughtTeardownError) {
      teardownError = caughtTeardownError;
    }
    if (teardownError) {
      throw formatBootFailure(repo.name, `${error instanceof Error ? error.message : String(error)}; ${teardownError instanceof Error ? teardownError.message : String(teardownError)}`, tail, lastLogLines);
    }
    throw formatBootFailure(repo.name, error, tail, lastLogLines);
  }
}
