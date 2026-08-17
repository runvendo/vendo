import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtractedTool } from "@vendoai/actions";
import { createAppTokens } from "@vendoai/apps";
import {
  VENDO_APP_FORMAT,
  type ActAs,
  type AppDocument,
  type Principal,
} from "@vendoai/core";
import { createStore, createStoreOps, storeFiles, type VendoStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo, type Vendo } from "../src/server.js";

/**
 * A BOXED app's host-tool call asks, and the tap makes THAT CALL run.
 *
 * `approve-resume.e2e.test.ts` is this journey one layer down — a tree action,
 * present. This is the layer-2 (machine) shape of it, and the difference is the
 * whole test: the caller is the box, over its own callback door with its
 * provision-time bearer, and it runs AWAY (nobody is looking at the box). A
 * boxed app that could not do this could not call ANY host tool: click → card →
 * Allow → nothing, then another card, forever.
 *
 * Everything here is the real thing: the composed umbrella, a real PGlite store,
 * the real guard, the real actions registry over a ROUTE binding, the real
 * `actAs` seam, and a real host HTTP server whose invoice really disappears.
 * Nothing is seeded — no grant row exists at any point, and the tap mints none
 * (asserted): a yes here authorizes exactly the call it was given, and the next
 * call asks again.
 */

const ADA: Principal = { kind: "user", subject: "user_ada" };
/** What the host's API accepts, and only the `actAs` seam can produce it. */
const AWAY_BEARER = "away-token-for-ada";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The host's own API, really listening: it deletes a real invoice, and only for
 *  a caller the away seam authenticated. */
async function invoiceHost(): Promise<{ baseUrl: string; invoices: Set<string>; unauthenticated: number }> {
  const state = { baseUrl: "", invoices: new Set(["inv_1"]), unauthenticated: 0 };
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += String(chunk)));
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.headers.authorization !== `Bearer ${AWAY_BEARER}`) {
        state.unauthenticated += 1;
        response.statusCode = 401;
        response.end(JSON.stringify({ error: "unauthenticated" }));
        return;
      }
      const { id } = JSON.parse(body === "" ? "{}" : body) as { id?: string };
      response.end(JSON.stringify({ deleted: id !== undefined && state.invoices.delete(id) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

/** One of the host's OWN endpoints, the way `vendo sync` records it — a route
 *  binding, which is the only kind of host tool that needs away authority. */
const deleteInvoice: ExtractedTool = {
  name: "host_invoices_delete",
  description: "Delete one of the customer's invoices",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  risk: "write",
  binding: { kind: "route", method: "POST", path: "/api/invoices/delete", argsIn: "body" },
};

/** A graduated (layer-2) app: its surface lives in a machine, and the machine
 *  calls back with the bearer provision minted. */
const doc = (): AppDocument => ({
  format: VENDO_APP_FORMAT,
  id: "app_box",
  name: "Invoice chaser",
  machine: { snapshotRef: "fake:snap", provisionedAt: "2026-08-01T00:00:00.000Z" },
});

const engineFor = (store: VendoStore) => createStoreOps(store, { files: storeFiles(store) }).engine;

async function setup(): Promise<{
  vendo: Vendo;
  host: Awaited<ReturnType<typeof invoiceHost>>;
  token: string;
}> {
  const host = await invoiceHost();
  // Single origin, as a real deployment has it: the host API and the wire.
  vi.stubEnv("VENDO_BASE_URL", host.baseUrl);
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-box-resume-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await store.ensureSchema();
  await store.records("vendo_apps").put({
    id: "app_box",
    data: { subject: ADA.subject, enabled: false, doc: doc() },
    refs: { subject: ADA.subject },
  });
  const actAs: ActAs = async () => ({ headers: { authorization: `Bearer ${AWAY_BEARER}` } });
  const vendo = createVendo({
    models: { default: {} as LanguageModel },
    principal: async (request) => {
      const subject = request.headers.get("x-test-user");
      return subject === null ? null : { kind: "user", subject };
    },
    store,
    tools: [deleteInvoice],
    actAs,
  });
  const token = await createAppTokens(engineFor(store)).mint("app_box", ADA.subject);
  return { vendo, host, token };
}

const wireRequest = (path: string, init: RequestInit = {}, subject?: string): Request => {
  const headers = new Headers(init.headers);
  if (subject !== undefined) headers.set("x-test-user", subject);
  return new Request(`http://wire.test/api/vendo${path}`, { ...init, headers });
};

/** The call the box makes: its own door, its own bearer, no host session. */
const boxCall = (token: string, id: string): Request =>
  wireRequest("/box/tools/host_invoices_delete", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ args: { id } }),
  });

const decide = (vendo: Vendo, approvalId: string, approve: boolean): Promise<Response> =>
  vendo.handler(wireRequest("/approvals/decide", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [approvalId], decision: { approve } }),
  }, ADA.subject));

async function park(vendo: Vendo, token: string, id: string): Promise<string> {
  const response = await vendo.handler(boxCall(token, id));
  expect(response.status).toBe(200);
  const outcome = await response.json() as { status: string; approvalId?: string };
  expect(outcome).toMatchObject({ status: "pending-approval" });
  return outcome.approvalId as string;
}

describe.sequential("a boxed app's host-tool call asks, and the tap runs THAT call", () => {
  it("parks, then lands the host effect the instant the owner approves", async () => {
    const { vendo, host, token } = await setup();

    const approvalId = await park(vendo, token, "inv_1");
    // The gate is holding the write: the invoice is still there.
    expect(host.invoices.has("inv_1")).toBe(true);

    expect((await decide(vendo, approvalId, true)).status).toBe(200);

    // THE REGRESSION: before the fix the tap changed nothing — no parked call
    // was remembered, so nothing re-dispatched, so the invoice survived.
    expect(host.invoices.has("inv_1")).toBe(false);
    // The host authenticated every call it served — the away seam really ran.
    expect(host.unauthenticated).toBe(0);
    // And the box can learn what happened: the resume's answer is persisted,
    // because the caller that pressed had its `pending-approval` long ago.
    const answer = await vendo.handler(wireRequest(`/approvals/${approvalId}`, {}, ADA.subject));
    expect(await answer.json()).toMatchObject({
      state: "executed",
      // The host's own answer, relayed: it deleted a row it really had.
      outcome: { status: "ok", output: { deleted: true } },
    });
  });

  it("a denied call never runs", async () => {
    const { vendo, host, token } = await setup();

    const approvalId = await park(vendo, token, "inv_1");
    expect((await decide(vendo, approvalId, false)).status).toBe(200);

    expect(host.invoices.has("inv_1")).toBe(true);
  });

  it("grants no standing authority: the yes runs one call, and the next asks again", async () => {
    const { vendo, token } = await setup();

    await decide(vendo, await park(vendo, token, "inv_1"), true);

    // Not one grant row exists — the tap authorized a call, not the app.
    const grants = await (await vendo.handler(wireRequest("/grants", {}, ADA.subject))).json();
    expect(grants).toEqual([]);
    // So the next call asks on its own account.
    await park(vendo, token, "inv_2");
  });
});
