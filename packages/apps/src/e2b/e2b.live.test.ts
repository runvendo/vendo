import { VENDO_APP_FORMAT, type AppDocument } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { sandboxAdapterConformance, type SandboxConformanceHarness } from "../adapter-conformance.js";
import { requestAppWithBootRetry } from "../box-agent.js";
import { createMachineLifecycle } from "../machine-lifecycle.js";
import type { SandboxMachine } from "../sandbox.js";
import { memoryStore, seedAppRow } from "../testing/index.js";
import { e2bSandbox } from "./index.js";

// ============================================================================
// execution-v2 Lane A LIVE lane — real E2B, real network, real snapshots.
// Gated on E2B_API_KEY + VENDO_LIVE_SANDBOX=1 (never runs in CI).
// Costs real sandbox-minutes; every machine is destroyed in afterEach/finally.
// ============================================================================

const LIVE = process.env.E2B_API_KEY !== undefined && process.env.VENDO_LIVE_SANDBOX === "1";
const decoder = new TextDecoder();
const LIVE_TIMEOUT_MS = 180_000;

/** The conformance app (see SandboxConformanceHarness contract), as a real
    node http server listening on the box's $PORT. */
const CONFORMANCE_SERVER_SOURCE = `
const http = require("node:http");
http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    const env = /^\\/conformance\\/env\\/([A-Za-z_][A-Za-z0-9_]*)$/.exec(request.url);
    if (env) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(process.env[env[1]] ?? "");
      return;
    }
    const egress = /^\\/conformance\\/egress\\/(.+)$/.exec(request.url);
    if (egress) {
      let allowed = false;
      // Two attempts: a machine resumed from a memory snapshot can hold a
      // dead keep-alive socket for this origin in the fetch pool; the first
      // attempt's abort evicts it and the retry opens a fresh connection.
      for (let attempt = 0; attempt < 2 && !allowed; attempt += 1) {
        try {
          await fetch("https://" + decodeURIComponent(egress[1]) + "/", {
            signal: AbortSignal.timeout(5000),
            redirect: "manual",
          });
          allowed = true;
        } catch {}
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ allowed }));
      return;
    }
    if (request.method === "POST" && request.url === "/fn/echo") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.concat(chunks));
      return;
    }
    response.writeHead(404);
    response.end("");
  });
}).listen(Number(process.env.PORT || 8080));
`;

/** Install and start the conformance app through the ADAPTER-PRIVATE surface
    (in production the in-box agent owns the inside of the box). */
const bootstrap = async (machine: SandboxMachine): Promise<void> => {
  const box = machine as unknown as {
    exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
    files: { write(path: string, bytes: Uint8Array | string): Promise<void> };
  };
  await box.files.write("/app/server.js", CONFORMANCE_SERVER_SOURCE);
  const started = await box.exec(
    [
      "i=0",
      "while [ $i -lt 20 ]; do",
      "  if [ -f /tmp/vendo-conformance.pid ] && kill -0 $(cat /tmp/vendo-conformance.pid) 2>/dev/null; then exit 0; fi",
      "  i=$((i + 1))",
      "  sleep 0.1",
      "done",
      "nohup node /app/server.js >/tmp/vendo-conformance.log 2>&1 &",
      "echo $! >/tmp/vendo-conformance.pid",
    ].join("\n"),
    { cwd: "/app", timeoutMs: 15_000 },
  );
  expect(started.code).toBe(0);
};

const makeAdapter = () => e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000 });

describe.skipIf(!LIVE)("e2bSandbox live", () => {
  const harness: SandboxConformanceHarness = {
    makeAdapter,
    bootstrap,
    enforcesAllowedDomains: true,
    multiPort: true,
    resumeForks: true,
    resumeReplacesPolicy: true,
  };
  sandboxAdapterConformance("real E2B", harness);

  // The Lane A gate, verbatim: create → box serves a hello HTTP app →
  // request() returns it → snapshot() → stop → resume(ref) → request() again
  // → destroy. Logged so the transcript lands in the PR body as evidence.
  it("passes the Lane A live round-trip gate", async () => {
    const transcript: string[] = [];
    const log = (line: string): void => {
      transcript.push(line);
      console.log(`[lane-a-gate] ${line}`);
    };
    const adapter = makeAdapter();
    let created: SandboxMachine | undefined;
    let resumed: SandboxMachine | undefined;
    let ref: string | undefined;
    try {
      created = await adapter.create({ env: { PORT: "8080", HELLO: "hello from the box" } });
      log(`create → machine ${created.id}`);
      await bootstrap(created);
      log("bootstrap → hello app serving on $PORT");

      const first = await created.request({ method: "GET", path: "/conformance/env/HELLO" });
      log(`request → ${first.status} "${decoder.decode(first.body)}"`);
      expect(first.status).toBe(200);
      expect(decoder.decode(first.body)).toBe("hello from the box");

      ref = await created.snapshot();
      log(`snapshot → ${ref.slice(0, 24)}… (${ref.length} chars)`);
      await created.stop();
      log("stop → machine paused (snapshot-preserving)");

      resumed = await adapter.resume(ref);
      log(`resume(ref) → machine ${resumed.id}`);
      const second = await resumed.request({ method: "GET", path: "/conformance/env/HELLO" });
      log(`request → ${second.status} "${decoder.decode(second.body)}"`);
      expect(second.status).toBe(200);
      expect(decoder.decode(second.body)).toBe("hello from the box");
      expect(resumed.id).not.toBe(created.id);
    } finally {
      await Promise.all([
        created?.destroy().catch(() => undefined),
        resumed?.destroy().catch(() => undefined),
      ]);
      if (ref !== undefined) await adapter.destroy(ref).catch(() => undefined);
      log("destroy → both machines and the snapshot ref gone");
      console.log(`[lane-a-gate] TRANSCRIPT\n${transcript.join("\n")}`);
    }
  }, LIVE_TIMEOUT_MS);

  // ── Wave 7 gate 1: extend-on-activity ─────────────────────────────────────
  // A busy box must outlive its create-time provider deadline. Timeline vs a
  // 90s TTL and the adapter's 60s extension throttle: activity at t≈0 slides
  // the deadline to ≈t90, activity at t≈70 (past the throttle) slides it to
  // ≈t160, so being alive at t≈100 is possible ONLY if both extensions landed.
  it("Wave 7 gate: activity slides the provider TTL past the create-time deadline", async () => {
    const transcript: string[] = [];
    const log = (line: string): void => {
      transcript.push(line);
      console.log(`[wave7-ttl-gate] ${line}`);
    };
    const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 90_000 });
    let machine: SandboxMachine | undefined;
    try {
      const startedAt = Date.now();
      const at = (): string => `t=${Math.round((Date.now() - startedAt) / 1000)}s`;
      machine = await adapter.create({ env: { PORT: "8080" } });
      log(`create → machine ${machine.id}, provider TTL 90s`);

      const box = machine as unknown as { exec(cmd: string): Promise<{ code: number; stdout: string }> };
      expect((await box.exec("echo one")).code).toBe(0);
      log(`${at()} exec activity → deadline slides to ≈t=90s`);

      await sleep(70_000);
      // request-path activity past the 60s throttle (no app is listening, so
      // the 502 is the app-level answer — the sandbox itself is alive).
      const poked = await machine.request({ method: "GET", path: "/" });
      log(`${at()} request activity (status ${poked.status}) → deadline slides to ≈t=160s`);

      await sleep(30_000);
      const alive = await box.exec("echo alive");
      log(`${at()} exec → code ${alive.code} "${alive.stdout.trim()}" (past the 90s create-time TTL)`);
      expect(alive.code).toBe(0);
      expect(alive.stdout.trim()).toBe("alive");
    } finally {
      await machine?.destroy().catch(() => undefined);
      log("destroy → machine gone");
      console.log(`[wave7-ttl-gate] TRANSCRIPT\n${transcript.join("\n")}`);
    }
  }, 300_000);

  // ── Wave 7 gate 2: stale-live-ref eviction ─────────────────────────────────
  // The provider kills a woken machine out from under the lifecycle (real
  // Sandbox.kill = the TTL/sweep failure mode); the SAME live handle must
  // answer the next request by evicting the dead entry and resuming the
  // durable snapshot ref transparently.
  it("Wave 7 gate: a provider-killed machine is evicted and re-woken from the durable ref", async () => {
    const transcript: string[] = [];
    const log = (line: string): void => {
      transcript.push(line);
      console.log(`[wave7-reap-gate] ${line}`);
    };
    const adapter = makeAdapter();
    const store = memoryStore();
    const doc: AppDocument = { format: VENDO_APP_FORMAT, id: "app_wave7_reap", name: "Wave 7 reap gate" };
    const lifecycle = createMachineLifecycle({
      store,
      sandbox: adapter,
      buildEnv: () => ({ PORT: "8080", HELLO: "wave7 survives the reap" }),
    });
    let seeded: SandboxMachine | undefined;
    let ref: string | undefined;
    try {
      // Seed a snapshot that SERVES an app (adapter-private bootstrap, exactly
      // like the Lane A gate), so recovery is provable end-to-end over HTTP.
      seeded = await adapter.create({ env: { PORT: "8080", HELLO: "wave7 survives the reap" } });
      await bootstrap(seeded);
      ref = await seeded.snapshot();
      await seeded.destroy();
      await seedAppRow(store, {
        ...doc,
        machine: { snapshotRef: ref, provisionedAt: new Date().toISOString() },
      }, "owner");
      log(`seeded app row with serving snapshot ${ref.slice(0, 24)}…`);

      const handle = await lifecycle.wake(doc);
      const first = await requestAppWithBootRetry(handle, { method: "GET", path: "/conformance/env/HELLO" });
      log(`wake + request → ${first.status} "${decoder.decode(first.body)}"`);
      expect(first.status).toBe(200);
      expect(decoder.decode(first.body)).toBe("wave7 survives the reap");

      const killedId = handle.id;
      const { Sandbox } = await import("e2b");
      await Sandbox.kill(killedId, { apiKey: process.env.E2B_API_KEY });
      log(`provider killed machine ${killedId} out-of-band (the TTL/sweep failure mode)`);

      // The SAME handle answers: dead-machine detection → eviction → resume
      // from the durable ref → the app serves again. No 502-until-idle-sweep.
      const second = await requestAppWithBootRetry(handle, { method: "GET", path: "/conformance/env/HELLO" });
      log(`same handle request → ${second.status} "${decoder.decode(second.body)}"`);
      expect(second.status).toBe(200);
      expect(decoder.decode(second.body)).toBe("wave7 survives the reap");
      const recovered = lifecycle.peek(doc.id);
      log(`recovered live machine ${recovered?.id} (≠ ${killedId})`);
      expect(recovered?.id).toBeDefined();
      expect(recovered?.id).not.toBe(killedId);
    } finally {
      await lifecycle.destroyMachine(doc).catch(() => undefined);
      if (ref !== undefined) await adapter.destroy(ref).catch(() => undefined);
      await seeded?.destroy().catch(() => undefined);
      log("destroy → live machine and snapshot ref gone");
      console.log(`[wave7-reap-gate] TRANSCRIPT\n${transcript.join("\n")}`);
    }
  }, 300_000);
});
