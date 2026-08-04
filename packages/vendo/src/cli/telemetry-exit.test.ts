import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * The CLI must exit the moment its command is done — no network condition may
 * hold the process open after the summary prints.
 *
 * The condition that broke it live: a captive-portal network accepts the TCP
 * connection to the telemetry endpoint and then never answers. `vendo init`
 * printed Done and sat there; `DO_NOT_TRACK=1` made it exit instantly, naming
 * telemetry as the handle. This spawns the real `bin/vendo.mjs` against
 * exactly that shape (a socket server that accepts and stays silent, spoken to
 * over https so the TLS handshake never completes) and asserts the process
 * still exits promptly.
 */

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(packageRoot, "bin", "vendo.mjs");

/** Generous enough that startup jitter can't flake it, tight enough to fail
 *  on the real bug — the stranded fetch socket held the process for ~10s
 *  (undici's connect timeout) past the summary. */
const EXIT_BUDGET_MS = 6_000;

let blackHole: Server;
let blackHoleUrl: string;
const sockets: Array<{ destroy: () => void }> = [];

beforeAll(async () => {
  blackHole = createServer((socket) => {
    // Accept, hold, never answer, never close.
    socket.on("error", () => {});
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
  const address = blackHole.address();
  if (address === null || typeof address === "string") throw new Error("no black-hole port");
  blackHoleUrl = `https://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

it("exits promptly when the telemetry endpoint accepts the connection and never answers", async () => {
  const home = await mkdtemp(join(tmpdir(), "vendo-telemetry-exit-"));
  try {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, "eject", "--list", home], {
      // A bare env on purpose: CI / DO_NOT_TRACK / VENDO_TELEMETRY_DISABLED
      // would opt out and the run would prove nothing. HOME points the
      // anonymous-id file at a throwaway dir.
      env: { PATH: process.env.PATH ?? "", HOME: home, VENDO_POSTHOG_HOST: blackHoleUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.resume();

    const exited = await new Promise<{ code: number | null; ms: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`vendo did not exit within ${EXIT_BUDGET_MS}ms`));
      }, EXIT_BUDGET_MS);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, ms: Date.now() - started });
      });
    });

    expect(exited.code).toBe(0);
    expect(exited.ms).toBeLessThan(EXIT_BUDGET_MS);
    // The command really ran (an exit that skipped the work would prove nothing).
    expect(stdout).toContain("Ejectable surfaces");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
