/**
 * The ONE permission wire, over a REAL guard and a real store on both sides: a
 * route answers from the same approvals and grants the guard's own check path
 * parked and minted. `@vendoai/ui` posts these five shapes; a mount that
 * answers a sixth is the drift this module exists to end.
 */
import type { StoreAdapter } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard, handlePermissionRequest, permissionsHandler } from "../src/index.js";
import { createMemoryStore } from "./fixtures/memory-store.js";
import { alice, bob, call, context, FixtureTools } from "./fixtures/tools.js";

const askWrites = { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };

function guardOf(store: StoreAdapter = createMemoryStore()) {
  return createGuard({ store, policy: askWrites });
}

/** A StoreAdapter whose record stores omit the optional atomic-revisions
 *  capability (02-store §4) — the deployment whose decisions and take-backs
 *  cannot be made single-use, so the guard fails them closed. */
function withoutAtomic(base: StoreAdapter): StoreAdapter {
  return {
    ...base,
    records(collection) {
      const { atomic: _atomic, ...rest } = base.records(collection);
      return rest;
    },
  };
}

/** Parks one guarded write — the pending ask every route below is about. */
async function park(guard: ReturnType<typeof guardOf>, id = "call_wire"): Promise<string> {
  const outcome = await guard.bind(new FixtureTools()).execute(call("host_write", { value: 1 }, id), context());
  if (outcome.status !== "pending-approval") throw new Error("expected a parked write");
  return outcome.approvalId;
}

describe("handlePermissionRequest", () => {
  it("GET /approvals hands a person their own pending asks", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);

    const result = await handlePermissionRequest(guard, alice, { method: "GET", path: "/approvals" });

    expect(result?.body).toMatchObject([{ id: approvalId }]);
    // Owner-scoped: someone else's queue is not this person's business.
    const other = await handlePermissionRequest(guard, bob, { method: "GET", path: "/approvals" });
    expect(other?.body).toEqual([]);
  });

  it("POST /approvals/decide decides the set and remembers what it was told to", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);

    const result = await handlePermissionRequest(guard, alice, {
      method: "POST",
      path: "/approvals/decide",
      body: { ids: [approvalId], decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } } },
    });

    expect(result?.body).toEqual({});
    expect(await guard.approvals.pending(alice)).toEqual([]);
    expect(await guard.grants.list(alice)).toMatchObject([{ tool: "host_write", duration: "standing" }]);
  });

  it("refuses a decide with no ids and a decide whose decision is not one", async () => {
    const guard = guardOf();
    const decide = (body: unknown): Promise<unknown> =>
      handlePermissionRequest(guard, alice, { method: "POST", path: "/approvals/decide", body });

    await expect(decide({ decision: { approve: true } })).rejects.toMatchObject({ code: "validation" });
    await expect(decide({ ids: [], decision: { approve: true } })).rejects.toMatchObject({ code: "validation" });
    await expect(decide({ ids: [""], decision: { approve: true } })).rejects.toMatchObject({ code: "validation" });
    await expect(decide({ ids: ["apr_1"] })).rejects.toMatchObject({ code: "validation" });
    await expect(decide({ ids: ["apr_1"], decision: { approve: "yes" } })).rejects.toMatchObject({ code: "validation" });
  });

  it("DELETE /approvals/:id takes a decision back", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);
    await guard.approvals.decide(approvalId, { approve: false }, alice);

    const result = await handlePermissionRequest(guard, alice, { method: "DELETE", path: `/approvals/${approvalId}` });

    expect(result?.body).toEqual({});
    // The no no longer stands, so the same call asks again.
    await expect(park(guard)).resolves.toBeTypeOf("string");
  });

  it("GET /grants lists and DELETE /grants/:id revokes", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);
    await guard.approvals.decide(
      approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );
    const listed = await handlePermissionRequest(guard, alice, { method: "GET", path: "/grants" });
    const [grant] = listed?.body as Array<{ id: string }>;

    const revoked = await handlePermissionRequest(guard, alice, { method: "DELETE", path: `/grants/${grant!.id}` });

    expect(revoked?.body).toEqual({});
    // Marked, not deleted — the trail keeps both answers, in order.
    expect(await guard.grants.list(alice)).toMatchObject([{ id: grant!.id, revokedAt: expect.any(String) }]);
  });

  it("falls THROUGH on anything outside the five — the caller's table still gets its turn", async () => {
    const guard = guardOf();
    const miss = (method: "GET" | "POST" | "DELETE", path: string): Promise<unknown> =>
      handlePermissionRequest(guard, alice, { method, path });

    await expect(miss("GET", "/mcp")).resolves.toBeUndefined();
    await expect(miss("GET", "/approvals/apr_1")).resolves.toBeUndefined();
    await expect(miss("DELETE", "/approvals")).resolves.toBeUndefined();
    await expect(miss("POST", "/approvals")).resolves.toBeUndefined();
    await expect(miss("POST", "/grants")).resolves.toBeUndefined();
    await expect(miss("DELETE", "/grants")).resolves.toBeUndefined();
    await expect(miss("GET", "/approvals/apr_1/history")).resolves.toBeUndefined();
  });
});

describe("permissionsHandler", () => {
  const request = (method: string, path: string, body?: unknown): Request =>
    new Request(`https://app.example.com${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });

  it("serves the five under its mount and falls through for the door beside them", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);
    const handler = permissionsHandler({ guard, principal: async () => alice });

    const listed = await handler(request("GET", "/api/vendo/approvals"));
    expect(await listed?.json()).toMatchObject([{ id: approvalId }]);
    // The MCP door lives under the SAME mount: one catch-all route serves both,
    // which only works if this hands the path back instead of 404ing it.
    expect(await handler(request("POST", "/api/vendo/mcp"))).toBeUndefined();
    expect(await handler(request("GET", "/healthz"))).toBeUndefined();
  });

  it("401s when nobody could be identified — never an empty list that reads as 'you have none'", async () => {
    const handler = permissionsHandler({ guard: guardOf(), principal: async () => null });

    const response = await handler(request("GET", "/api/vendo/approvals"));

    expect(response?.status).toBe(401);
  });

  it("answers a decide, and turns a bad one into a 400 rather than a crash", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);
    const handler = permissionsHandler({ guard, principal: async () => alice });

    const decided = await handler(request("POST", "/api/vendo/approvals/decide", {
      ids: [approvalId],
      decision: { approve: true },
    }));
    expect(decided?.status).toBe(200);
    expect(await guard.approvals.pending(alice)).toEqual([]);

    const bad = await handler(request("POST", "/api/vendo/approvals/decide", { ids: [] }));
    expect(bad?.status).toBe(400);
    expect(await bad?.json()).toMatchObject({ error: { code: "validation" } });
  });

  /** A refusal minted by a SECOND `@vendoai/core` copy (a host bundle carrying
   *  both the ESM and CJS builds) is a different class, so the gate's
   *  `instanceof` said no and rethrew — the host's route crashed on a refusal
   *  that has a perfectly good status. */
  it("maps a refusal from another realm's VendoError onto its status too", async () => {
    const guard = guardOf();
    const refused = Object.assign(new Error("approvals are not enabled for this deployment"), {
      name: "VendoError",
      code: "blocked",
    });
    const handler = permissionsHandler({
      guard: { ...guard, approvals: { ...guard.approvals, pending: async () => { throw refused; } } },
      principal: async () => alice,
    });

    const response = await handler(request("GET", "/api/vendo/approvals"));

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ error: { code: "blocked" } });
  });

  it("maps the guard's own refusals onto their statuses", async () => {
    const guard = guardOf();
    const handler = permissionsHandler({ guard, principal: async () => alice });

    const missing = await handler(request("DELETE", "/api/vendo/grants/grt_nope"));
    expect(missing?.status).toBe(404);

    const approvalId = await park(guard);
    // Pending, so a take-back conflicts — deny it instead.
    const pending = await handler(request("DELETE", `/api/vendo/approvals/${approvalId}`));
    expect(pending?.status).toBe(409);
  });

  it("501s where the store cannot do it at all — never 403, which reads as 'you may not'", async () => {
    // A decision and a take-back both need the store's atomic revisions to be
    // single-use; an adapter that omits them fails them closed with
    // `not-implemented`. That is a fact about the DEPLOYMENT, and a client that
    // reads it as an authorization denial re-prompts a person who cannot help.
    const base = createMemoryStore();
    const full = guardOf(base);
    const pendingId = await park(full, "call_wire_501_pending");
    const decidedId = await park(full, "call_wire_501_decided");
    await full.approvals.decide(decidedId, { approve: false }, alice);
    const handler = permissionsHandler({ guard: guardOf(withoutAtomic(base)), principal: async () => alice });

    const decided = await handler(request("POST", "/api/vendo/approvals/decide", {
      ids: [pendingId],
      decision: { approve: true },
    }));
    expect(decided?.status).toBe(501);
    expect(await decided?.json()).toMatchObject({ error: { code: "not-implemented" } });

    const revoked = await handler(request("DELETE", `/api/vendo/approvals/${decidedId}`));
    expect(revoked?.status).toBe(501);
    expect(await revoked?.json()).toMatchObject({ error: { code: "not-implemented" } });
  });

  it("honors a custom mount", async () => {
    const guard = guardOf();
    const handler = permissionsHandler({ guard, principal: async () => alice, mount: "/permissions" });

    expect((await handler(request("GET", "/permissions/grants")))?.status).toBe(200);
    expect(await handler(request("GET", "/api/vendo/grants"))).toBeUndefined();
  });
});
