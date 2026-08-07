/** Boots ONE fixture host-app server for the whole e2e run and provides its
 * base URL to every suite (vitest globalSetup). The wave-3 actions e2e booted
 * per-file; with five suites here one shared server keeps the run fast.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
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

async function waitForFixture(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null) throw new Error(`Fixture exited early (${child?.exitCode})\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/fixture/reset`, { method: "POST" });
      if (response.ok) return;
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
    // Own dist dir → own dev-server lock; the actions and automations fixture
    // e2e suites may be booting the same host app concurrently under turbo.
    // Nested under .next so scanners and gitignore rules that already skip
    // .next cover it.
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FIXTURE_DIST_DIR: ".next/redteam-e2e" },
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
