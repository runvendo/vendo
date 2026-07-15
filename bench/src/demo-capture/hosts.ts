import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { DemoHost } from "./cli-args.js";

export type ConcreteDemoHost = Exclude<DemoHost, "both">;

export interface DemoHostDefinition {
  id: ConcreteDemoHost;
  label: string;
  packageName: "demo-bank" | "demo-accounting";
  route: string;
  threadId: string;
}

export const demoHosts: Record<ConcreteDemoHost, DemoHostDefinition> = {
  maple: {
    id: "maple",
    label: "MAPLE",
    packageName: "demo-bank",
    route: "/vendo",
    threadId: "thr_maple_demo",
  },
  cadence: {
    id: "cadence",
    label: "CADENCE",
    packageName: "demo-accounting",
    route: "/assistant",
    threadId: "thr_cadence_demo",
  },
};

const port3000Lock = "/tmp/vendo-l3-port3000.lock";

export interface RunningDemoHost {
  baseUrl: string;
  stop(): Promise<void>;
}

export function demoHostCommandArgs(packageName: DemoHostDefinition["packageName"], port: number): string[] {
  // pnpm's filtered script invocation already treats everything after `dev`
  // as script arguments. Supplying another `--` reaches `next dev` literally
  // and Next mistakes the following flag for a project directory.
  return [
    "--filter", packageName, "dev",
    "--hostname", "127.0.0.1",
    "--port", String(port),
  ];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquirePortLock(port: number, timeoutMs: number): Promise<(() => Promise<void>) | undefined> {
  if (port !== 3000) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(port3000Lock);
      return async () => {
        await rmdir(port3000Lock).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the shared port-3000 lock at ${port3000Lock}`);
      }
      await delay(1_000);
    }
  }
}

async function tcpReady(url: string): Promise<boolean> {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: parsed.hostname, port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(2_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function waitUntilReady(url: string, process: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Demo host exited before ${url} became ready (code ${process.exitCode})`);
    if (await tcpReady(url)) return;
    await delay(500);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`);
}

async function waitUntilHttpReady(url: string, process: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Demo host exited before ${url} served HTTP (code ${process.exitCode})`);
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(remaining) });
      if (response.status < 500) return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(500);
    }
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for HTTP from ${url}`);
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }),
  ]);
}

export async function bootDemoHost(options: {
  host: DemoHostDefinition;
  port: number;
  repoRoot: string;
  logFile: string;
  timeoutMs: number;
}): Promise<RunningDemoHost> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is missing; source the Flowlet .env before running a live demo capture");
  }
  const releaseLock = await acquirePortLock(options.port, Math.max(options.timeoutMs, 600_000));
  await mkdir(path.dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: "a" });
  const child = spawn(
    "pnpm",
    demoHostCommandArgs(options.host.packageName, options.port),
    {
      cwd: options.repoRoot,
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  try {
    await waitUntilReady(baseUrl, child, options.timeoutMs);
    await waitUntilHttpReady(new URL(options.host.route, baseUrl).toString(), child, options.timeoutMs);
  } catch (error) {
    await stopProcess(child);
    log.end();
    await releaseLock?.();
    throw error;
  }

  let stopped = false;
  return {
    baseUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      await stopProcess(child);
      log.end();
      await releaseLock?.();
    },
  };
}
