/**
 * ADVERSARIAL CHECK on the shared permission wire. Not written by the author of
 * the change. Two questions only: can principal A touch principal B's rows on
 * any of the five routes, and can a crafted path reach a route it should not.
 */
import { describe, expect, it } from "vitest";
import { createGuard, handlePermissionRequest, permissionsHandler } from "../src/index.js";
import { createMemoryStore, type MemoryStore } from "./fixtures/memory-store.js";
import { alice, bob, call, context, FixtureTools } from "./fixtures/tools.js";

const askWrites = { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };

function guardOf(store: MemoryStore = createMemoryStore()) {
  return createGuard({ store, policy: askWrites });
}

async function park(guard: ReturnType<typeof guardOf>, id = "call_check"): Promise<string> {
  const outcome = await guard.bind(new FixtureTools()).execute(call("host_write", { value: 1 }, id), context());
  if (outcome.status !== "pending-approval") throw new Error("expected a parked write");
  return outcome.approvalId;
}

/** Alice parks, approves and remembers — one live grant of hers to attack. */
async function aliceGrant(guard: ReturnType<typeof guardOf>): Promise<string> {
  const approvalId = await park(guard, "call_check_grant");
  await guard.approvals.decide(
    approvalId,
    { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
    alice,
  );
  const [grant] = await guard.grants.list(alice);
  return grant!.id;
}

describe("CHECK: cross-subject on every one of the five routes", () => {
  it("POST /approvals/decide cannot decide someone else's ask", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);

    await expect(handlePermissionRequest(guard, bob, {
      method: "POST",
      path: "/approvals/decide",
      body: { ids: [approvalId], decision: { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } } },
    })).rejects.toMatchObject({ code: "not-found" });

    expect(await guard.approvals.pending(alice)).toHaveLength(1);
    expect(await guard.grants.list(bob)).toEqual([]);
  });

  it("DELETE /approvals/:id cannot take back someone else's decision", async () => {
    const guard = guardOf();
    const approvalId = await park(guard);
    await guard.approvals.decide(approvalId, { approve: false }, alice);

    await expect(handlePermissionRequest(guard, bob, {
      method: "DELETE",
      path: `/approvals/${approvalId}`,
    })).rejects.toMatchObject({ code: "not-found" });
  });

  it("DELETE /grants/:id cannot revoke someone else's grant", async () => {
    const guard = guardOf();
    const grantId = await aliceGrant(guard);

    await expect(handlePermissionRequest(guard, bob, {
      method: "DELETE",
      path: `/grants/${grantId}`,
    })).rejects.toMatchObject({ code: "not-found" });

    const [still] = await guard.grants.list(alice);
    expect(still!.id).toBe(grantId);
    expect(still!.revokedAt).toBeUndefined();
  });

  it("GET /grants shows a stranger nothing of hers", async () => {
    const guard = guardOf();
    await aliceGrant(guard);

    const listed = await handlePermissionRequest(guard, bob, { method: "GET", path: "/grants" });

    expect(listed?.body).toEqual([]);
  });
});

describe("CHECK: a GET must never reach a DELETE", () => {
  it("GET /grants/:id neither reads nor revokes", async () => {
    const guard = guardOf();
    const grantId = await aliceGrant(guard);

    const result = await handlePermissionRequest(guard, alice, { method: "GET", path: `/grants/${grantId}` });

    expect(result).toBeUndefined();
    const [still] = await guard.grants.list(alice);
    expect(still!.id).toBe(grantId);
    expect(still!.revokedAt).toBeUndefined();
  });
});

describe("CHECK: the mount prefix is a PATH boundary, not a string prefix", () => {
  const request = (method: string, path: string): Request =>
    new Request(`https://app.example.com${path}`, { method });

  it("a sibling path that merely starts with the mount is NOT on the mount", async () => {
    const guard = guardOf();
    const handler = permissionsHandler({ guard, principal: async () => alice });

    // `/api/vendo` is the mount. `/api/vendoapprovals` is a DIFFERENT path that
    // happens to share its first ten characters — it is not one of the five.
    expect(await handler(request("GET", "/api/vendoapprovals"))).toBeUndefined();
    expect(await handler(request("GET", "/api/vendogrants"))).toBeUndefined();
  });

  it("the same hole on a custom mount", async () => {
    const guard = guardOf();
    const handler = permissionsHandler({ guard, principal: async () => alice, mount: "/permissions" });

    expect(await handler(request("GET", "/permissionsgrants"))).toBeUndefined();
  });
});
