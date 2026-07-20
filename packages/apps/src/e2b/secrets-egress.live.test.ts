import type { AppDocument, RunContext, SecretsProvider, ToolRegistry } from "@vendoai/core";
import { VENDO_APP_FORMAT } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { buildEnv } from "../box-env.js";
import { boxAllowlist } from "../egress-approval.js";
import { createApps } from "../index.js";
import type { BuildMachineEnv } from "../machine-lifecycle.js";
import type { SandboxMachine } from "../sandbox.js";
import { guardFixture, memoryStore, seedAppRow } from "../testing/index.js";
import { e2bSandbox } from "./index.js";

// ============================================================================
// execution-v2 Lane E LIVE gate — real E2B, real network policy, real secrets.
// Gated on E2B_API_KEY + VENDO_LIVE_SANDBOX=1 (never runs in CI).
// Proves, on a real box: the approved allowlist lets example.com through and
// blocks an unlisted domain; a granted secret is visible in the box env; and
// the value never appears in any host-side artifact (app document, store
// rows, audit events, fn responses). Every machine/snapshot is destroyed.
// ============================================================================

const LIVE = process.env.E2B_API_KEY !== undefined && process.env.VENDO_LIVE_SANDBOX === "1";
const LIVE_TIMEOUT_MS = 240_000;
const decoder = new TextDecoder();

/** A recognizable fixture value — never a real credential. */
const SECRET_VALUE = "vlive_s3cret_lane_e_gate_2026_07_19";
const SECRET_NAME = "VENDO_LIVE_SECRET";
const ALLOWED_DOMAIN = "example.com";
const BLOCKED_DOMAIN = "httpbin.org";
const IMPLICIT_DOMAIN = "host.vendo.test";

/** Same conformance app as the Lane A live lane (env echo + egress probe). */
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

const bootstrap = async (machine: SandboxMachine): Promise<void> => {
  // The ADAPTER-PRIVATE bootstrap surface (in production the in-box agent
  // owns the inside of the box) — same shape the Lane A live test uses.
  const box = machine as unknown as {
    exec(cmd: string, opts?: { cwd?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
    files: { write(path: string, bytes: Uint8Array | string): Promise<void> };
  };
  await box.files.write("/app/server.js", CONFORMANCE_SERVER_SOURCE);
  const started = await box.exec(
    "nohup node /app/server.js >/tmp/vendo-conformance.log 2>&1 &\necho $! >/tmp/vendo-conformance.pid",
    { cwd: "/app", timeoutMs: 15_000 },
  );
  expect(started.code).toBe(0);
};

const tools: ToolRegistry = {
  async descriptors() {
    return [];
  },
  async execute() {
    return { status: "error", error: { code: "not-found", message: "no fixture tools" } };
  },
};

const ada: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "app",
  presence: "present",
  sessionId: "session_lane_e_live",
};

describe.skipIf(!LIVE)("Lane E live gate: secrets + egress allowlist on real E2B", () => {
  it("allowlisted egress works, unlisted is blocked, the secret lives in the box and nowhere host-side", async () => {
    const transcript: string[] = [];
    const log = (line: string): void => {
      transcript.push(line);
      console.log(`[lane-e-gate] ${line}`);
    };

    const store = memoryStore();
    const guard = guardFixture();
    const adapter = e2bSandbox({ apiKey: process.env.E2B_API_KEY, timeoutMs: 120_000 });
    const secretsProvider: SecretsProvider = {
      async get(name) {
        return name === SECRET_NAME ? SECRET_VALUE : undefined;
      },
    };
    // The REAL env assembler (Lane C's buildEnv), driven by the grant set the
    // runtime resolves — exactly the host wiring in @vendoai/vendo's server.
    const hostBuildEnv: BuildMachineEnv = async (doc, grants) => (await buildEnv(doc, {
      granted: grants?.grantedSecrets ?? new Set<string>(),
      secrets: secretsProvider,
      storeUrl: `https://${IMPLICIT_DOMAIN}/api/vendo/box`,
      hostUrl: `https://${IMPLICIT_DOMAIN}/api/vendo/box`,
      appToken: "vsk_live_fixture_token",
    })).env;

    const doc: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_lane_e_live",
      name: "Lane E live gate",
      egress: [ALLOWED_DOMAIN],
      secrets: [SECRET_NAME],
    };
    await seedAppRow(store, doc, ada.principal.subject);
    const runtime = createApps({
      store,
      guard,
      tools,
      catalog: [],
      secrets: secretsProvider,
      machine: {
        sandbox: adapter,
        buildEnv: hostBuildEnv,
        implicitDomains: [IMPLICIT_DOMAIN],
      },
    });

    const storedDoc = async (): Promise<AppDocument> => {
      const record = await store.records("vendo_apps").get(doc.id);
      if (record === null) throw new Error("app row is gone");
      return (record.data as { doc: AppDocument }).doc;
    };

    let seeded: SandboxMachine | undefined;
    let seededRef: string | undefined;
    try {
      // 1. Grant the secret through the ENG-345 exposure flow.
      const exposure = await runtime.secrets.setExposure(
        { appId: doc.id, secretName: SECRET_NAME, expose: true },
        ada,
      );
      if (exposure.status !== "pending-approval") throw new Error(`unexpected ${exposure.status}`);
      guard.decide(exposure.approvalId, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      log(`secret grant → ${SECRET_NAME} approved for injection`);

      // 2. The egress grant flow: provision refuses, the card is approved.
      await expect(runtime.machine.provision(doc.id, ada)).rejects.toMatchObject({
        code: "blocked",
        detail: expect.objectContaining({ unapprovedDomains: [ALLOWED_DOMAIN] }),
      });
      const card = guard.approvals[guard.approvals.length - 1];
      if (card === undefined) throw new Error("no parked egress approval");
      guard.decide(card.id, true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const approved = await storedDoc();
      expect(approved.egressApproved).toEqual([ALLOWED_DOMAIN]);
      log(`egress grant → ${ALLOWED_DOMAIN} approved (declared in vendo.json terms)`);

      // 3. Boot a real box exactly the way the lifecycle would: the policy
      //    allowlist + the grant-resolved env, then install the probe app and
      //    snapshot it as the app's machine (the in-box agent's role here).
      const allowlist = boxAllowlist(approved, [IMPLICIT_DOMAIN]);
      expect(allowlist).toEqual([ALLOWED_DOMAIN, IMPLICIT_DOMAIN]);
      const env = await hostBuildEnv(approved, { grantedSecrets: new Set([SECRET_NAME]) });
      seeded = await adapter.create({ env, allowedDomains: allowlist });
      log(`create → machine ${seeded.id} with allowOut ${JSON.stringify(allowlist)}`);
      await bootstrap(seeded);

      // Secret IS in the box env (raw, adapter-level probe).
      const inBox = await seeded.request({ method: "GET", path: `/conformance/env/${SECRET_NAME}` });
      expect(decoder.decode(inBox.body)).toBe(SECRET_VALUE);
      log("box env → granted secret visible inside the box");

      seededRef = await seeded.snapshot();
      await store.records("vendo_apps").put({
        id: doc.id,
        data: {
          subject: ada.principal.subject,
          enabled: false,
          doc: { ...approved, machine: { snapshotRef: seededRef, provisionedAt: new Date().toISOString() } },
        },
        refs: { subject: ada.principal.subject },
      });
      await seeded.destroy();
      seeded = undefined;
      log("snapshot → stored as the app's machine; source destroyed");

      // 4. The fn door wakes the machine through the lifecycle (resume carries
      //    the CURRENT policy) and every probe crosses the host seam.
      const allowedProbe = await runtime.box.request(doc.id, {
        method: "GET",
        path: `/conformance/egress/${ALLOWED_DOMAIN}`,
      }, ada);
      expect(JSON.parse(decoder.decode(allowedProbe.body))).toEqual({ allowed: true });
      log(`egress → ${ALLOWED_DOMAIN} reachable from the box`);

      const blockedProbe = await runtime.box.request(doc.id, {
        method: "GET",
        path: `/conformance/egress/${BLOCKED_DOMAIN}`,
      }, ada);
      expect(JSON.parse(decoder.decode(blockedProbe.body))).toEqual({ allowed: false });
      log(`egress → ${BLOCKED_DOMAIN} blocked at the network layer`);

      // The same env probe through the HOST seam comes back redacted: the fn
      // door never relays a secret value to clients or logs.
      const throughHost = await runtime.box.request(doc.id, {
        method: "GET",
        path: `/conformance/env/${SECRET_NAME}`,
      }, ada);
      expect(decoder.decode(throughHost.body)).toBe(`[redacted:${SECRET_NAME}]`);
      log("fn door → response redacted host-side");

      // 5. Host-side artifact sweep: the value appears NOWHERE the host keeps.
      const finalDoc = await storedDoc();
      expect(JSON.stringify(finalDoc)).not.toContain(SECRET_VALUE);
      expect(finalDoc.secrets).toEqual([SECRET_NAME]); // the NAME is declared…
      expect(JSON.stringify(await store.records("vendo_apps").list({}))).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(guard.audit)).not.toContain(SECRET_VALUE);
      log("host artifacts → app document, store rows, audit events all clean");
    } finally {
      await seeded?.destroy().catch(() => undefined);
      // destroyMachine reaps the live resume AND the stored snapshot ref.
      await runtime.machine.destroy(doc.id, ada).catch(() => undefined);
      if (seededRef !== undefined) await adapter.destroy(seededRef).catch(() => undefined);
      log("destroy → machines and snapshots gone");
      console.log(`[lane-e-gate] TRANSCRIPT\n${transcript.join("\n")}`);
    }
  }, LIVE_TIMEOUT_MS);
});
