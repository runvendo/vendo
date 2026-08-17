/** MACHINE SKIN (execution-v2 Wave 1 Lane C) — the whole boundary of the box,
 * through the REAL composed umbrella over HTTP, with a fake sandbox adapter
 * standing in for the provider:
 *
 *   tree-side call (POST /apps/:id/fn/:name, ADA's session)
 *     → wire fn proxy → apps.box door wakes the fake machine
 *     → the box fn handler runs and calls BACK across the skin using only its
 *       provision-time env (buildEnv output: VENDO_STORE_URL / VENDO_HOST_URL
 *       + VENDO_APP_TOKEN):
 *         - writes a durable row  (PUT  /box/rows/notes/note_1)
 *         - calls an auto-allowed host tool     (host_invoices_list → ok)
 *         - calls an approval-gated host tool   (host_invoices_delete → the
 *           PENDING outcome relays; nothing bypasses the guard)
 *     → a second tree-side fn call reads the row back through the box.
 *
 * Graduation's machine step (Lane B) is SETUP here, not the subject: it is
 * seeded as the row it leaves behind (a document pointing at the fake box's own
 * snapshot ref), because the journey pins its own bearer + env anyway so the
 * fake box acts on a KNOWN provision-time environment. The env assembler itself
 * is exercised below, directly, through the real `buildEnv`.
 *
 * Presence model: box callbacks run AWAY (the box acts for the owner without
 * the owner in the loop — the automations model), so the guard's 05 §6 rule
 * applies: only an app-bound, automation-source grant authorizes a run;
 * everything else parks. "Auto-allowed" below = grant-authorized (the journey
 * seeds the grant row an automations-style enable flow mints — box grant UX is
 * a later lane); the destructive tool holds no grant and must park.
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildEnv, createAppTokens, type SandboxAdapter, type SandboxMachine } from "@vendoai/apps";
import { descriptorHash, VENDO_APP_FORMAT, type AppDocument, type PermissionGrant } from "@vendoai/core";
import { createStoreOps, storeFiles, type VendoStore } from "@vendoai/store";
import {
  ADA,
  BOB,
  createStack,
  hostFetch,
  importApp,
  resetFixture,
  type Stack,
} from "../src/harness.js";

/** The app-token rows are one of Vendo's own drawers, reached by name through
 *  the engine family. The harness store is really SQL-backed, so it gets the
 *  REAL engine rather than the adapter shim. */
const engineFor = (store: VendoStore) => createStoreOps(store, { files: storeFiles(store) }).engine;

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The seed document the journey imports (the import boundary re-mints the id). */
const seedDoc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: "app_machine_skin_seed",
  name: "Machine skin journey",
  ui: "tree",
  secrets: ["STRIPE_KEY"],
};

/** The box: an in-process "server" whose fn handlers act ONLY on the env the
 * provisioner injected — the same position real box code is in. */
function fakeBox(): { sandbox: SandboxAdapter; setEnv(env: Record<string, string>): void } {
  let boxEnv: Record<string, string> = {};

  const callback = async (path: string, init: RequestInit): Promise<{ status: number; json: unknown }> => {
    const response = await fetch(path, {
      ...init,
      headers: {
        authorization: `Bearer ${boxEnv["VENDO_APP_TOKEN"]}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  };

  const handlers: Record<string, () => Promise<unknown>> = {
    "/fn/record": async () => {
      const stored = await callback(`${boxEnv["VENDO_STORE_URL"]}/rows/notes/note_1`, {
        method: "PUT",
        body: JSON.stringify({ data: { text: "chase inv_0003" } }),
      });
      const list = await callback(`${boxEnv["VENDO_HOST_URL"]}/tools/host_invoices_list`, {
        method: "POST",
        body: JSON.stringify({ args: {} }),
      });
      const destructive = await callback(`${boxEnv["VENDO_HOST_URL"]}/tools/host_invoices_delete`, {
        method: "POST",
        body: JSON.stringify({ args: { id: "inv_0003" } }),
      });
      return { stored, list: list.json, destructive: destructive.json };
    },
    "/fn/readNote": async () => {
      const note = await callback(`${boxEnv["VENDO_STORE_URL"]}/rows/notes/note_1`, { method: "GET" });
      return { note: note.json };
    },
  };

  const machine: SandboxMachine = {
    id: "fake_box_machine",
    async request(request) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const handler = request.method === "POST" ? handlers[request.path] : undefined;
      if (handler === undefined) {
        return { status: 404, headers, body: encoder.encode(JSON.stringify({ error: "no such fn" })) };
      }
      const result = await handler();
      return { status: 200, headers, body: encoder.encode(JSON.stringify(result)) };
    },
    // The skin journey is the fn/callback boundary, never the box's disk — the
    // seam member is here so this double stays a whole SandboxMachine, and it
    // fails loudly rather than answering a file it does not hold.
    files: {
      async read(path) { throw new Error(`the machine-skin box holds no files (${path})`); },
      async write(path) { throw new Error(`the machine-skin box holds no files (${path})`); },
      async list(dir) { throw new Error(`the machine-skin box holds no files (${dir})`); },
    },
    async url(port?: number) { return `https://${port ?? 8080}-fake_box_machine.skin.test`; },
    async snapshot() { return "fake:machine-skin"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };

  return {
    sandbox: {
      async create() { return machine; },
      async resume() { return machine; },
      async destroy() { /* released */ },
    },
    setEnv(env) { boxEnv = env; },
  };
}

describe("machine skin: fn proxy, buildEnv, and the callback surface through the composed wire", () => {
  it("tree call → box → durable row + guarded host tools (allowed ok, destructive pending) → tree-side read", async () => {
    await resetFixture();
    const box = fakeBox();
    stack = await createStack({ sandbox: box.sandbox });

    // Import the app through the public wire as ADA.
    const app = await importApp(stack, seedDoc, ADA);

    // --- Graduation's machine step (Lane B), as the ROW it leaves behind: the
    // box exists and the document points at its snapshot. Provisioning is the
    // internal lifecycle graduation drives (`lifecycle.provision`, box-lane.ts)
    // and there is no manual door onto it; its env is not what this journey
    // acts on either — the bearer and env below are pinned deliberately. The
    // ref is the one this fake sandbox's own snapshot() hands back, so every
    // wake resumes something the provider really produced.
    const row = await stack.vendo.store.records("vendo_apps").get(app.id);
    const stored = row?.data as { subject: string; enabled: boolean; doc: AppDocument };
    await stack.vendo.store.records("vendo_apps").put({
      id: app.id,
      data: {
        ...stored,
        doc: {
          ...stored.doc,
          machine: { snapshotRef: "fake:machine-skin", provisionedAt: new Date().toISOString() },
        },
      },
      refs: { subject: ADA.subject },
    });

    // The journey pins its own bearer + env so the fake box can act on a KNOWN
    // provision-time environment; the granted-secrets half of the composed
    // assembler is the Wave-2 secrets lane.
    const token = await createAppTokens(engineFor(stack.vendo.store)).mint(app.id, ADA.subject);
    const built = await buildEnv(app, {
      granted: new Set(["STRIPE_KEY"]),
      secrets: { get: async (name) => (name === "STRIPE_KEY" ? "sk_live_integration" : undefined) },
      storeUrl: `${stack.baseUrl}/api/vendo/box`,
      hostUrl: `${stack.baseUrl}/api/vendo/box`,
      appToken: token,
    });
    // The env IS the contract: PORT + granted secret + callback doors.
    expect(built.env).toMatchObject({
      PORT: "8080",
      STRIPE_KEY: "sk_live_integration",
      VENDO_APP_TOKEN: token,
      VENDO_STORE_URL: `${stack.baseUrl}/api/vendo/box`,
      VENDO_HOST_URL: `${stack.baseUrl}/api/vendo/box`,
    });
    expect(built.injectedSecrets).toEqual(["STRIPE_KEY"]);
    box.setEnv(built.env);

    // The away-authorization half of the provision stand-in: the app-bound,
    // automation-source grant that lets the box run host_invoices_list for
    // ADA (exactly the row the automations enable flow mints). No grant
    // exists for host_invoices_delete, so it must park.
    const descriptor = (await stack.vendo.actions.descriptors()).find((d) => d.name === "host_invoices_list");
    if (descriptor === undefined) throw new Error("fixture tool host_invoices_list missing");
    const grant: PermissionGrant = {
      id: "grt_machine_skin_list",
      subject: ADA.subject,
      tool: "host_invoices_list",
      descriptorHash: descriptorHash(descriptor),
      scope: { kind: "tool" },
      duration: "standing",
      appId: app.id,
      source: "automation",
      grantedAt: new Date().toISOString(),
    };
    await stack.vendo.store.records("vendo_grants").put({
      id: grant.id,
      data: grant as never,
      refs: { subject: grant.subject, tool: grant.tool, app_id: app.id },
    });

    // --- Cross-user boundary first: BOB cannot reach ADA's fn door ---------
    const bob = await stack.wireFetch(`/apps/${app.id}/fn/record`, { method: "POST", body: "{}" }, BOB);
    expect(bob.status).toBe(404);

    // --- The tree-side call: proxy → box → callbacks -----------------------
    const called = await stack.wireFetch(`/apps/${app.id}/fn/record`, { method: "POST", body: "{}" }, ADA);
    expect(called.status).toBe(200);
    const outcome = (await called.json()) as {
      stored: { status: number };
      list: { status: string };
      destructive: { status: string; approvalId?: string };
    };
    // Durable row accepted; auto-allowed tool ran; destructive tool PARKED —
    // the pending shape relays to the box, the guard is never bypassed.
    expect(outcome.stored.status).toBe(200);
    expect(outcome.list.status).toBe("ok");
    expect(outcome.destructive.status).toBe("pending-approval");
    expect(outcome.destructive.approvalId).toMatch(/^apr_/);

    // The approval is REAL: parked on disk for ADA, and the invoice survives.
    const approvals = await stack.sql<{ status: string; subject: string }>(
      "SELECT status, subject FROM vendo_approvals",
    );
    expect(approvals).toEqual([{ status: "pending", subject: ADA.subject }]);
    expect((await hostFetch("/api/invoices/inv_0003", ADA.subject)).status).toBe(200);

    // The allowed call is audited like any tree action (one perimeter).
    const activity = (await (await stack.wireFetch("/activity", {}, ADA)).json()) as Array<{ tool?: string }>;
    expect(activity.some((event) => event.tool === "host_invoices_list")).toBe(true);

    // --- Tree-side read sees the row, through the box ----------------------
    const read = await stack.wireFetch(`/apps/${app.id}/fn/readNote`, { method: "POST", body: "{}" }, ADA);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ note: { id: "note_1", data: { text: "chase inv_0003" } } });

    // A stale/forged bearer is refused at the callback door.
    const forged = await fetch(`${stack.baseUrl}/api/vendo/box/rows/notes/note_1`, {
      headers: { authorization: `Bearer vat_${"0".repeat(64)}` },
    });
    expect(forged.status).toBe(401);

    // Nothing about the token or the secret leaked into the app document.
    const rows = await stack.sql<{ doc: unknown }>("SELECT doc FROM vendo_apps");
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("sk_live_integration");
  });
});
