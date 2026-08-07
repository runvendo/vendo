/** Boots one fixture host-app server for the full MCP e2e run. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

const fixtureDir = fileURLToPath(new URL("../../host-app/", import.meta.url));
const nextBin = join(fixtureDir, "node_modules", ".bin", "next");

let child: ChildProcessWithoutNullStreams | undefined;
let serverOutput = "";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate fixture port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

/** Next dev compiles API routes lazily; under parallel-suite CPU load a first
 *  request to an uncompiled dynamic route can 404/500 before the route module
 *  finishes compiling (see packages/actions/src/runtime/fixture.e2e.test.ts).
 *  Touch each route family once (any status counts — we only need the
 *  compile) and retry transient dev-compile failures so tests — including
 *  resetFixture()'s POST /fixture/reset — assert against a warm server. */
async function warmRoutes(baseUrl: string, deadline: number): Promise<void> {
  const paths = ["/api/login", "/api/invoices", "/api/invoices/inv_warmup", "/api/customers", "/fixture/reset", "/fixture/echo"];
  for (const path of paths) {
    let warm = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${baseUrl}${path}`);
        // 404/500 with an HTML body is the dev compiler mid-flight; anything
        // else (2xx/4xx JSON) means the route module is compiled and serving.
        if (response.status !== 404 && response.status !== 500) { warm = true; break; }
        const body = await response.text();
        if (!body.startsWith("<!DOCTYPE")) { warm = true; break; }
      } catch {
        // Server hiccup while compiling — retry below.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    // The shared deadline expiring mid-warmup must fail loudly, not fall
    // through silently: a still-cold route here means setup would otherwise
    // publish fixtureBaseUrl anyway, and the first test hits the exact
    // cold-route 404/500 this warmup exists to prevent. Same posture as
    // waitForFixture's own timeout below.
    if (!warm) throw new Error(`Fixture route ${path} did not warm up in time\n${serverOutput}`);
  }
}

async function waitForFixture(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Fixture exited early (${child?.exitCode})\n${serverOutput}`);
    try {
      const response = await fetch(baseUrl);
      if (response.ok) {
        await warmRoutes(baseUrl, deadline);
        return;
      }
    } catch {
      // Next is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Fixture did not become ready\n${serverOutput}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(nextBin, ["dev", "-p", String(port)], {
    cwd: fixtureDir,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FIXTURE_DIST_DIR: ".next/mcp-e2e" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  child.stderr.on("data", (chunk) => {
    serverOutput = `${serverOutput}${String(chunk)}`.slice(-20_000);
  });
  await waitForFixture(baseUrl);
  project.provide("fixtureBaseUrl", baseUrl);

  return async () => {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) child.kill("SIGKILL");
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    fixtureBaseUrl: string;
  }
}
