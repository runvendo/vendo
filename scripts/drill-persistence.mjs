#!/usr/bin/env node
/**
 * Kill-the-server persistence drill (docs/superpowers/plans/
 * 2026-07-04-automations-oss-persistence.md, Task 19). Scripts spec
 * acceptance items 1-4 end to end against apps/demo-bank:
 *
 *   1. seed durable state directly against the store (server down, no LLM)
 *   2. boot the real Next.js server (VENDO_DRILL=1 wires the handler's
 *      built-in automations world + a durable storage default)
 *   3. assert every surface reads back over HTTP, SIGKILL, reboot, assert
 *      again — proving the restart survives
 *   4. leave the server running untouched long enough for the
 *      instrumentation-booted in-process scheduler to fire the seeded cron
 *      automation with NO client request driving it, then read the run
 *      history back OFFLINE and assert the grant was honored
 *
 * Storage backend: PGlite by default (a temp dir). Set DATABASE_URL (e.g. a
 * local Docker Postgres) to run the same drill against real Postgres instead.
 *
 * Exit code is non-zero on any failed assertion; the failing assertion is
 * printed before exit. Always kills any child server process and removes the
 * temp PGlite dir on the way out (success, failure, or Ctrl-C).
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCOPE,
  VENDO_ID,
  THREAD_ID,
  THREAD_MESSAGES,
} from "./drill-persistence.constants.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const demoBankFilter = "demo-bank";
const storeScript = path.join(here, "drill-persistence-store.mjs");

const DATABASE_URL = process.env.DATABASE_URL;
const usingPostgres = Boolean(DATABASE_URL);

const cleanup = { serverProc: null, dataDir: null };
let exitCode = 0;

function log(msg) {
  console.log(`[drill] ${msg}`);
}

function fail(msg) {
  throw new Error(`ASSERTION FAILED: ${msg}`);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { stdio: "inherit", cwd: repoRoot, ...opts });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${cmd} ${args.join(" ")}`);
  }
}

function runStoreScript(cmd, arg, env) {
  const args = arg ? [storeScript, cmd, arg] : [storeScript, cmd];
  const result = spawnSync("node", args, { cwd: repoRoot, env, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`drill-persistence-store.mjs ${cmd} failed (${result.status})`);
  }
  const lastLine = result.stdout.trim().split("\n").pop();
  return JSON.parse(lastLine);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseEnv(dataDir) {
  return {
    ...process.env,
    VENDO_DRILL: "1",
    VENDO_ALLOW_REMOTE: "1",
    NODE_ENV: "production",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-ant-drill-placeholder-not-used",
    ...(usingPostgres ? { DATABASE_URL } : { VENDO_DATA_DIR: dataDir }),
  };
}

async function startServer(port, env) {
  // detached: the child gets its own process GROUP so killServer can SIGKILL
  // the whole tree. `pnpm exec` forks next, which forks next-server — killing
  // only the pnpm wrapper orphans a still-listening next-server: the
  // "rebooted" server then dies with EADDRINUSE while the orphan silently
  // keeps answering the reboot assertions, faking restart-survival (found
  // live on this drill's first runs).
  const proc = spawn(
    "pnpm",
    ["--filter", demoBankFilter, "exec", "next", "start", "-p", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  cleanup.serverProc = proc;
  const tail = [];
  const capture = (buf) => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim()) tail.push(line);
      if (tail.length > 200) tail.shift();
    }
  };
  proc.stdout.on("data", capture);
  proc.stderr.on("data", capture);
  proc.tail = tail;

  let exited = false;
  proc.on("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`server process exited before becoming ready:\n${tail.join("\n")}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/api/vendo/capabilities`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await sleep(300);
  }
  throw new Error(`server never became ready on port ${port}:\n${tail.join("\n")}`);
}

async function killServer(proc, port) {
  if (proc && proc.exitCode === null) {
    await new Promise((resolve) => {
      proc.on("exit", resolve);
      // Negative pid = the whole detached process group (pnpm + next +
      // next-server). Fall back to the single pid if the group is gone.
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    });
  }
  cleanup.serverProc = null;
  // PROOF OF DEATH: the port must actually go dark before this returns —
  // otherwise a surviving orphan could serve the post-"reboot" assertions.
  if (port !== undefined) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        await fetch(`http://localhost:${port}/api/vendo/capabilities`, {
          signal: AbortSignal.timeout(1_000),
        });
      } catch {
        return; // connection refused/timed out — nothing is listening
      }
      if (Date.now() > deadline) {
        throw new Error(`port ${port} still answering ${15_000}ms after SIGKILL — an orphaned server survived`);
      }
      await sleep(300);
    }
  }
}

async function assertSurfaces(port, label) {
  const caps = await (await fetch(`http://localhost:${port}/api/vendo/capabilities`)).json();
  if (caps.storage !== true) fail(`[${label}] GET capabilities storage=${caps.storage}, expected true`);
  log(`[${label}] capabilities.storage === true`);

  const vendosList = await (await fetch(`http://localhost:${port}/api/vendo/vendos`)).json();
  if (!Array.isArray(vendosList) || !vendosList.some((f) => f.id === VENDO_ID)) {
    fail(`[${label}] GET vendos did not include seeded id "${VENDO_ID}": ${JSON.stringify(vendosList)}`);
  }
  log(`[${label}] GET vendos lists the seeded vendo`);

  const vendoOne = await (await fetch(`http://localhost:${port}/api/vendo/vendos/${VENDO_ID}`)).json();
  if (vendoOne.id !== VENDO_ID) {
    fail(`[${label}] GET vendos/${VENDO_ID} returned ${JSON.stringify(vendoOne)}`);
  }
  log(`[${label}] GET vendos/<id> returns the seeded record`);

  const threadsList = await (await fetch(`http://localhost:${port}/api/vendo/threads`)).json();
  if (!Array.isArray(threadsList) || !threadsList.some((t) => t.id === THREAD_ID)) {
    fail(`[${label}] GET threads did not include seeded id "${THREAD_ID}": ${JSON.stringify(threadsList)}`);
  }
  log(`[${label}] GET threads lists the seeded thread`);

  const messages = await (await fetch(`http://localhost:${port}/api/vendo/threads/${THREAD_ID}`)).json();
  if (!Array.isArray(messages) || messages.length !== THREAD_MESSAGES.length) {
    fail(`[${label}] GET threads/${THREAD_ID} returned ${JSON.stringify(messages)}, expected ${THREAD_MESSAGES.length} messages`);
  }
  const ids = messages.map((m) => m.id);
  for (const expected of THREAD_MESSAGES) {
    if (!ids.includes(expected.id)) fail(`[${label}] thread messages missing id "${expected.id}": got ${JSON.stringify(ids)}`);
  }
  log(`[${label}] GET threads/<id> returns the seeded messages in order`);
}

async function main() {
  log(`storage backend: ${usingPostgres ? `Postgres (${DATABASE_URL})` : "PGlite (temp dir)"}`);

  log("building the workspace");
  run("pnpm", ["build"]);
  run("pnpm", ["--filter", demoBankFilter, "build"]);

  const dataDir = usingPostgres ? null : mkdtempSync(path.join(tmpdir(), "vendo-drill-"));
  cleanup.dataDir = dataDir;
  const env = baseEnv(dataDir);

  log("seeding fixtures directly against the store (server down)");
  const seeded = runStoreScript("seed", null, env);
  const automationId = seeded.automationId;
  log(`seeded automation ${automationId}`);

  const port = await getFreePort();
  log(`booting the server on port ${port} (first boot)`);
  await startServer(port, env);
  await assertSurfaces(port, "first boot");

  log("SIGKILL-ing the server (process group) and confirming the port goes dark");
  await killServer(cleanup.serverProc, port);

  log("rebooting the server");
  await startServer(port, env);
  await assertSurfaces(port, "reboot");

  log("leaving the server untouched for 75s so the instrumentation-booted cron can fire");
  await sleep(75_000);

  log("SIGKILL-ing the server (final)");
  const finalTail = cleanup.serverProc?.tail?.slice(-40) ?? [];
  await killServer(cleanup.serverProc, port);

  log("reading run history back offline through the store");
  const verified = runStoreScript("verify", automationId, env);

  const succeeded = verified.runs.filter(
    (r) => r.status === "succeeded" && r.outcome === undefined && r.pendingApproval === undefined,
  );
  if (succeeded.length === 0) {
    fail(
      `no succeeded, grant-honored run found for automation ${automationId}. ` +
        `runs: ${JSON.stringify(verified.runs, null, 2)}\nlast server output:\n${finalTail.join("\n")}`,
    );
  }
  log(`found ${succeeded.length} succeeded run(s), none waiting_approval, none with a pendingApproval — grant honored`);

  if (verified.decision !== "approve") {
    fail(`decision did not survive the restart: expected "approve", got ${JSON.stringify(verified.decision)}`);
  }
  log("decision survived the restart");

  if (!verified.vendo || verified.vendo.id !== VENDO_ID) {
    fail(`vendo did not survive the restart: ${JSON.stringify(verified.vendo)}`);
  }
  if (!Array.isArray(verified.messages) || verified.messages.length !== THREAD_MESSAGES.length) {
    fail(`thread messages did not survive the restart: ${JSON.stringify(verified.messages)}`);
  }
  log("saved vendo + thread messages confirmed durable offline");

  log("DRILL PASSED");
}

async function cleanupAll() {
  await killServer(cleanup.serverProc);
  if (cleanup.dataDir) {
    try {
      rmSync(cleanup.dataDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

process.on("SIGINT", async () => {
  await cleanupAll();
  process.exit(130);
});

try {
  await main();
} catch (err) {
  exitCode = 1;
  console.error(`[drill] ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await cleanupAll();
}
process.exit(exitCode);
