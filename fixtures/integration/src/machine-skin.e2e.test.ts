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
 * Provisioning (machine ref on the document, wake-on-schedule) is Lane B; this
 * journey stands in for it exactly where Lane B will call Lane C's seams:
 * createAppTokens().mint at provision and buildEnv for the box environment.
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
import { descriptorHash, VENDO_APP_FORMAT, VENDO_TREE_FORMAT_V2, type AppDocument, type PermissionGrant } from "@vendoai/core";
import {
  ADA,
  BOB,
  createStack,
  hostFetch,
  importAutomation,
  resetFixture,
  type Stack,
} from "./harness.js";

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
  tree: {
    formatVersion: VENDO_TREE_FORMAT_V2,
    root: "root",
    nodes: [{ id: "root", component: "Text", props: { text: "invoice chaser" } }],
  },
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
    async snapshot() { return "fake:machine-skin"; },
    async stop() { /* sleep */ },
    async destroy() { /* gone */ },
  };

  return {
    sandbox: {
      async create() { return machine; },
      async resume() { return machine; },
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
    const app = await importAutomation(stack, seedDoc, ADA);

    // --- Provision: graduation's machine step (Lane B) — creates the box
    // from the fake adapter, composes env through the umbrella's assembler
    // (buildEnv + token mint), snapshots, and stores the machine ref.
    await stack.vendo.apps.machine.provision(app.id, {
      principal: ADA,
      venue: "app",
      presence: "present",
      sessionId: "session_machine_skin",
    });

    // The journey pins its own bearer + env (rotating provision's mint) so the
    // fake box can act on a KNOWN provision-time environment; the granted-
    // secrets half of the composed assembler is the Wave-2 secrets lane.
    const token = await createAppTokens(stack.vendo.store).mint(app.id, ADA.subject);
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
