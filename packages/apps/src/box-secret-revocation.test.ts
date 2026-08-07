/**
 * The revocation seam: a secret the owner takes away must not reach the box.
 *
 * Both halves are REAL here, which is the whole point (CLAUDE.md's seam rule).
 * The WRITE path is the host's own: `secrets.setExposure({expose:false})`, the
 * env-stale marker, the wake-time rebuild in `machine-lifecycle`, the boundary
 * env `box-env.ts` assembles, and `pushBoxEnv`'s POST to the control port. The
 * READ path is the box's own: the real `createHarness()` persisting
 * `.vendo/env.json`, respawning the supervised app, and that app answering from
 * its OWN `process.env` — read back through `requestAppWithBootRetry`, the same
 * transport the host reads a box's app with. Nothing between the grant flip and
 * the app's environment is a double.
 *
 * The one stand-in is the PROVIDER (e2b), and it stands in for neither side of
 * this seam. `fakeBoxSandbox` — the double the rest of the suite uses — models
 * this harness's env door, and it disagreed with it: the model REPLACED the box
 * env while the harness MERGED the injected set OVER the machine's process env,
 * where a provision-time secret value sits (e2b applies create-time `envs`
 * sandbox-wide). So a revoked secret survived every restart while
 * `grant-env-reinjection.test.ts` asserted it was gone — producer and consumer
 * each mocking the other. This suite is the seam neither of them crossed.
 */
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { VENDO_APP_FORMAT, type AppDocument, type RunContext, type SecretsProvider, type ToolRegistry } from "@vendoai/core";
import { afterEach, describe, expect, it } from "vitest";
// The box harness ships as zero-dependency runtime .mjs baked into the base
// template; this drives the real module, exactly as box-harness.test.ts does.
import { createHarness } from "../box/harness.mjs";
import { BOX_CONTROL_PORT, requestAppWithBootRetry } from "./box-agent.js";
import { buildEnv } from "./box-env.js";
import { createApps } from "./index.js";
import type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
import { guardFixture, memoryStore, seedAppRow } from "./testing/index.js";

const SECRET_NAME = "STRIPE_KEY";
const SECRET_VALUE = "sk_live_seam_fixture";

const decoder = new TextDecoder();

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_user_ada",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
  },
};

/** The app the in-box agent would have written: it serves its OWN env on $PORT.
 *  Same probe shape as the live e2b gate (`GET /conformance/env/<NAME>`). */
const APP_SOURCE = `
import http from "node:http";
http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(process.env));
}).listen(Number(process.env.PORT));
`;

const freePort = async (): Promise<number> => await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.on("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    probe.close(() => resolve(port));
  });
});

interface HarnessBox {
  appDir: string;
  controlPort: number;
  stop: () => Promise<void>;
}

/**
 * The PROVIDER, and only the provider. A machine is a real harness supervising a
 * real app process:
 *   - `create` hands the boundary env to the harness as its process env, which
 *     is what e2b's create-time `envs` does (sandbox-wide, every process in the
 *     box, harness included) — plus the machine's own PATH/HOME, which the
 *     container supplies and no host ever sends.
 *   - `snapshot` / `resume` restart the harness over the SAME app directory with
 *     the SAME create-time env: a resume restores the box's memory and disk, and
 *     no provider re-sends create-time env at resume. That is a box RESTART, the
 *     case the bug hid in.
 *   - a refused connection answers 503, the provider's "port not open yet",
 *     which is what `requestAppWithBootRetry` is written against.
 */
const harnessSandbox = (appPort: number) => {
  const boxes: HarnessBox[] = [];
  const snapshots = new Map<string, { appDir: string; env: Record<string, string> }>();
  let nextId = 1;
  let nextSnap = 1;

  const machineEnv = (): Record<string, string> => ({
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? tmpdir(),
  });

  const boot = async (appDir: string, env: Record<string, string>): Promise<SandboxMachine> => {
    const harness = createHarness({
      appDir,
      controlPort: 0,
      baseEnv: { ...machineEnv(), ...env },
      // The agent engine is out of this seam's way; the env it would be handed
      // comes from the same boundaryEnv() the app is spawned with.
      runAgentTask: async () => ({ ok: true, summary: "", filesChanged: [], testsRun: 0 }),
    });
    await harness.start();
    const address = harness.server.address();
    const controlPort = typeof address === "object" && address !== null ? address.port : 0;
    const box: HarnessBox = { appDir, controlPort, stop: () => harness.stop() };
    boxes.push(box);
    const id = `harnessbox-${nextId++}`;
    let running = true;
    const machine: SandboxMachine = {
      id,
      async request(req) {
        if (!running) throw new Error(`${id} is not running`);
        const target = (req.port ?? appPort) === BOX_CONTROL_PORT ? controlPort : (req.port ?? appPort);
        try {
          const response = await fetch(`http://127.0.0.1:${target}${req.path}`, {
            method: req.method,
            ...(req.headers === undefined ? {} : { headers: req.headers }),
            ...(req.body === undefined ? {} : { body: req.body }),
          });
          return {
            status: response.status,
            headers: Object.fromEntries(response.headers),
            body: new Uint8Array(await response.arrayBuffer()),
          };
        } catch {
          // The provider's gateway answer while the port is not open.
          return { status: 503, headers: {}, body: new Uint8Array() };
        }
      },
      async url(port) {
        return `http://127.0.0.1:${port ?? appPort}`;
      },
      // The box's disk is a real directory; no part of this seam reads it, but
      // the provider owns these three operations and they are one line each.
      files: {
        async read(target) {
          return readFileSync(path.join(appDir, target));
        },
        async write(target, bytes) {
          mkdirSync(path.dirname(path.join(appDir, target)), { recursive: true });
          writeFileSync(path.join(appDir, target), bytes);
        },
        async list(dir) {
          return readdirSync(path.join(appDir, dir));
        },
      },
      async snapshot() {
        const ref = `harnessbox:snap_${nextSnap++}`;
        // The disk survives a snapshot, so the ref keeps pointing at this app
        // directory; the lifecycle destroys the source machine right after, so
        // no two live machines ever share it.
        snapshots.set(ref, { appDir, env });
        return ref;
      },
      async stop() {
        running = false;
        await harness.stop();
      },
      async destroy() {
        running = false;
        await harness.stop();
      },
    };
    return machine;
  };

  const adapter: SandboxAdapter = {
    async create(spec) {
      const appDir = mkdtempSync(path.join(tmpdir(), "vendo-seam-box-"));
      // The app the agent already built: its source, and the Procfile entry the
      // supervisor runs it with.
      mkdirSync(path.join(appDir, ".vendo"), { recursive: true });
      writeFileSync(path.join(appDir, "app.mjs"), APP_SOURCE);
      writeFileSync(path.join(appDir, ".vendo", "run"), `${JSON.stringify(process.execPath)} app.mjs`);
      return await boot(appDir, spec.env);
    },
    async resume(snapshotRef) {
      const snap = snapshots.get(snapshotRef);
      if (snap === undefined) throw new Error(`unknown snapshot: ${snapshotRef}`);
      return await boot(snap.appDir, snap.env);
    },
    async destroy(snapshotRef) {
      snapshots.delete(snapshotRef);
    },
  };

  const teardown = async (): Promise<void> => {
    for (const box of boxes.splice(0)) {
      await box.stop().catch(() => undefined);
      rmSync(box.appDir, { recursive: true, force: true });
    }
  };

  return { adapter, teardown };
};

const teardowns: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const teardown of teardowns.splice(0)) await teardown();
});

const app = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_secret_revocation",
  name: "Revocation seam fixture",
  secrets: [SECRET_NAME],
});

const setup = async () => {
  const appPort = await freePort();
  const store = memoryStore();
  const guard = guardFixture();
  const { adapter, teardown } = harnessSandbox(appPort);
  teardowns.push(teardown);
  const doc = app();
  await seedAppRow(store, doc, ada.principal.subject);
  const secrets: SecretsProvider = {
    async get(name) {
      return name === SECRET_NAME ? SECRET_VALUE : undefined;
    },
  };
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    secrets,
    machine: {
      sandbox: adapter,
      // The REAL env assembler, driven by the grant set the runtime resolves —
      // the same wiring @vendoai/vendo's server hands the lifecycle.
      buildEnv: async (document, grants) => (await buildEnv(document, {
        granted: grants?.grantedSecrets ?? new Set<string>(),
        secrets,
        storeUrl: "https://host.example/api/vendo/box",
        hostUrl: "https://host.example/api/vendo/box",
        appToken: `vat_${"a".repeat(64)}`,
        port: appPort,
      })).env,
    },
  });

  /** Grant the secret through the real exposure flow (owner-approved). */
  const grant = async (): Promise<void> => {
    const pending = await runtime.secrets.setExposure(
      { appId: doc.id, secretName: SECRET_NAME, expose: true },
      ada,
    );
    if (pending.status !== "pending-approval") throw new Error(`unexpected status ${pending.status}`);
    guard.decide(pending.approvalId, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  /** What the app process ACTUALLY has in its environment, right now. */
  const appEnv = async (machine: SandboxMachine): Promise<Record<string, string>> => {
    const answer = await requestAppWithBootRetry(
      machine,
      { method: "GET", path: "/", port: appPort },
      // The window is one app respawn (SIGTERM + spawn + bind), generous enough
      // that a busy machine cannot read as a product failure.
      { attempts: 40, delayMs: 500 },
    );
    expect(answer.status).toBe(200);
    return JSON.parse(decoder.decode(answer.body)) as Record<string, string>;
  };

  return { runtime, doc, guard, grant, appEnv, appPort };
};

describe("a revoked secret does not reach the box (host revocation ↔ real in-box harness)", () => {
  it("is gone from the supervised app's own env after the restart the revocation forces", async () => {
    const { runtime, doc, grant, appEnv } = await setup();

    await grant();
    await runtime.machine.provision(doc.id, ada);
    const granted = await runtime.machine.wake(doc.id, ada);
    // The seam is live: the granted value really is inside the box, in the
    // process env of the app the supervisor spawned.
    expect((await appEnv(granted))[SECRET_NAME]).toBe(SECRET_VALUE);

    // The owner takes it away. A grant flip on a RUNNING box sleeps it, so the
    // next wake is a real restart: resume (the box's memory and disk come back,
    // create-time env included) + the rebuilt boundary env through the control
    // port.
    await runtime.secrets.setExposure({ appId: doc.id, secretName: SECRET_NAME, expose: false }, ada);
    const revoked = await runtime.machine.wake(doc.id, ada);

    const env = await appEnv(revoked);
    expect(env[SECRET_NAME]).toBeUndefined();
    // The rest of the boundary is intact — the revocation is the only thing
    // that changed, and the app can still start, serve and call home.
    expect(env.VENDO_APP_TOKEN).toBe(`vat_${"a".repeat(64)}`);
    expect(env.VENDO_STORE_URL).toBe("https://host.example/api/vendo/box");
    // The machine's own vars are the machine's business, not the host's.
    expect(env.PATH).toBe(process.env.PATH);
  }, 60_000);

  it("stays gone across a later restart that re-injects nothing at all", async () => {
    const { runtime, doc, grant, appEnv } = await setup();

    await grant();
    await runtime.machine.provision(doc.id, ada);
    await runtime.machine.wake(doc.id, ada);
    await runtime.secrets.setExposure({ appId: doc.id, secretName: SECRET_NAME, expose: false }, ada);
    // The revocation lands (this wake clears the env-stale marker).
    await runtime.machine.wake(doc.id, ada);

    // An ORDINARY sleep/wake now: no grant changed, so nothing is re-injected
    // and the box comes back with its create-time env plus whatever is on its
    // disk. That disk env is the whole boundary, and the revoked value is not
    // in it.
    await runtime.machine.sleep(doc.id, ada);
    const restarted = await runtime.machine.wake(doc.id, ada);

    const env = await appEnv(restarted);
    expect(env[SECRET_NAME]).toBeUndefined();
    expect(env.PORT).toBeDefined();
  }, 60_000);
});
