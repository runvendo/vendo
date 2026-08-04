import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, rmdir } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import type { DemoConfig } from "demo-template/demo-config";
import type { DemoHost } from "./cli-args.js";

export type ConcreteDemoHost = Exclude<DemoHost, "both">;

/** What booting + driving any demo host needs. Config-driven hosts have no
 * login wall, so the password knobs are optional; `packageName` is whatever
 * the app's package.json declares. */
export interface CaptureHostDefinition {
  id: string;
  label: string;
  packageName: string;
  route: string;
  threadId: string;
  /** ENG-260 put both demos behind a real login wall. The /login form
   * prefills the primary seeded demo user's email, so the capture only needs
   * the shared demo password: the deploy-time env knob when set, otherwise
   * the seeded dev fallback. */
  demoPasswordEnv?: string;
  demoPasswordFallback?: string;
}

export interface DemoHostDefinition extends CaptureHostDefinition {
  id: ConcreteDemoHost;
  packageName: "demo-bank" | "demo-accounting";
  demoPasswordEnv: string;
  demoPasswordFallback: string;
}

export const demoHosts: Record<ConcreteDemoHost, DemoHostDefinition> = {
  maple: {
    id: "maple",
    label: "MAPLE",
    packageName: "demo-bank",
    route: "/vendo",
    threadId: "thr_maple_demo",
    demoPasswordEnv: "MAPLE_DEMO_PASSWORD",
    demoPasswordFallback: "maple-demo",
  },
  cadence: {
    id: "cadence",
    label: "CADENCE",
    packageName: "demo-accounting",
    route: "/assistant",
    threadId: "thr_cadence_demo",
    demoPasswordEnv: "CADENCE_DEMO_PASSWORD",
    // Must match the canon: cadenceDemoPassword() in
    // examples/demo-accounting/src/server/users.ts.
    demoPasswordFallback: "cadence-demo",
  },
};

/**
 * The generic adapter for a template-derived demo app (examples/demo-template or
 * a per-prospect clone). Everything is derived from the app directory by the
 * template's conventions, not flags:
 *
 *  - `packageName` comes from the app's own package.json — the boot still
 *    goes through `pnpm --filter <name> dev`.
 *  - `route` is always `/vendo`: the template's panel page is fenced plumbing
 *    that clones keep.
 *  - `threadId` derives deterministically from the demo id the same way the
 *    concrete hosts pin theirs (`thr_maple_demo`): hyphens become
 *    underscores, e.g. "acme-widgets" → `thr_acme_widgets_demo`.
 *  - Password knobs: a template-derived app fronts itself with a login wall
 *    (DEMO_PASSWORD env on the deployment, seeded fallback `<id>-demo`), and
 *    the sign-in helper still no-ops for any host without a /login form.
 *
 * demo.config.json is validated with the app's OWN zod schema
 * (`demo-template/demo-config`), so a malformed config fails here with the
 * schema's message instead of half-booting a broken demo.
 */
export async function configDemoHost(appDir: string): Promise<{ host: CaptureHostDefinition; config: DemoConfig }> {
  const packagePath = path.join(appDir, "package.json");
  const packageName: unknown = (JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>).name;
  if (typeof packageName !== "string" || packageName === "") {
    throw new Error(`Cannot boot the demo app: no "name" in "${packagePath}"`);
  }
  // Loaded lazily: the demo-template/demo-config export resolves to
  // TypeScript SOURCE that node executes via type stripping (Node >= 23.6).
  // That works because pnpm's workspace symlink resolves OUT of node_modules
  // (stripping refuses real node_modules paths; --preserve-symlinks would
  // break it). A top-level import would take down every beat on older Node,
  // while bench's engines floor is >= 20 — only demo-beats pays this cost.
  let parseDemoConfig: typeof import("demo-template/demo-config").parseDemoConfig;
  try {
    ({ parseDemoConfig } = await import("demo-template/demo-config"));
  } catch (error) {
    throw new Error(
      "demo-beats needs Node >= 23.6 (native TypeScript type stripping) to load the app's own demo.config schema; "
      + `the maple/cadence/montage beats are unaffected. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const configPath = path.join(appDir, "demo.config.json");
  const config = parseDemoConfig(
    JSON.parse(readFileSync(configPath, "utf8")),
    `demo config at "${configPath}"`,
  );
  return {
    host: {
      id: config.id,
      label: config.prospect.toUpperCase(),
      packageName,
      route: "/vendo",
      threadId: `thr_${config.id.replaceAll("-", "_")}_demo`,
      // A template-derived app fronts itself with a login wall; the sign-in
      // helper drives it with the deployment knob or the seeded fallback (the
      // same pattern as the first-party hosts).
      demoPasswordEnv: "DEMO_PASSWORD",
      demoPasswordFallback: `${config.id}-demo`,
    },
    config,
  };
}

const port3000Lock = "/tmp/vendo-l3-port3000.lock";

export interface RunningDemoHost {
  baseUrl: string;
  stop(): Promise<void>;
}

/** `standalone` = the app is a scratch demo clone outside this checkout, so
 * there is no workspace to filter — it is booted from its own directory. */
export function demoHostCommandArgs(
  packageName: CaptureHostDefinition["packageName"],
  port: number,
  options: { standalone?: boolean } = {},
): string[] {
  // pnpm's filtered script invocation already treats everything after `dev`
  // as script arguments. Supplying another `--` reaches `next dev` literally
  // and Next mistakes the following flag for a project directory.
  return [
    ...(options.standalone === true ? [] : ["--filter", packageName]),
    "dev",
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
  host: CaptureHostDefinition;
  port: number;
  repoRoot: string;
  logFile: string;
  timeoutMs: number;
  /** The app's own directory. Pass it for config-driven hosts: a scratch demo
   * clone lives outside the repo and boots from there instead of by workspace
   * filter. Omit for the first-party hosts, which are always members. */
  appDir?: string;
}): Promise<RunningDemoHost> {
  // Either key is a working inference posture (BYO provider / Cloud gateway);
  // with neither, the boot succeeds and every beat fails on the first turn.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.VENDO_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY or VENDO_API_KEY is missing; source the Flowlet .env before running a live demo capture");
  }
  const standalone = options.appDir !== undefined
    && path.relative(options.repoRoot, options.appDir).startsWith("..");
  const releaseLock = await acquirePortLock(options.port, Math.max(options.timeoutMs, 600_000));
  await mkdir(path.dirname(options.logFile), { recursive: true });
  const log = createWriteStream(options.logFile, { flags: "a" });
  const child = spawn(
    "pnpm",
    demoHostCommandArgs(options.host.packageName, options.port, { standalone }),
    {
      cwd: standalone ? (options.appDir as string) : options.repoRoot,
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
