import { descriptorHash } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { alice, call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §2 stage 2: a grant matches only an unrevoked, unexpired grant whose
// descriptorHash still equals the tool's current descriptor. Flipping risk,
// revoking, or expiry all lapse the grant back to a park.
describe("grant lapses on descriptor drift, revocation, and expiry", () => {
  const blockingGuard = (store: ReturnType<typeof createMemoryStore>, tool: string) =>
    createGuard({ store, policy: { rules: [{ match: { tool }, action: "block", note: "no grant" }] } });

  it("matches the frozen descriptor but lapses when the same tool flips to destructive", async () => {
    const store = createMemoryStore();
    const writeDesc = descriptor("write", { name: "host_drift" });
    const destructiveDesc = descriptor("destructive", { name: "host_drift" });
    await seedGrant(store, { descriptor: writeDesc });
    const guard = blockingGuard(store, "host_drift");

    // The grant authorizes the exact descriptor it was minted for.
    await expect(
      guard.check(call("host_drift", { amount: 1 }, "call_ok"), writeDesc, context()),
    ).resolves.toMatchObject({ action: "run", decidedBy: "grant" });

    // The registry now serves the same name as a destructive tool: descriptorHash
    // drifts, the grant lapses, and the rule blocks instead.
    await expect(
      guard.check(call("host_drift", { amount: 1 }, "call_flip"), destructiveDesc, context()),
    ).resolves.toMatchObject({ action: "block", decidedBy: "rule" });
  });

  it("does not match a revoked grant", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_revoked" });
    await seedGrant(store, { descriptor: d, revokedAt: "2020-01-01T00:00:00.000Z" });
    const guard = blockingGuard(store, "host_revoked");

    await expect(
      guard.check(call("host_revoked", { amount: 1 }, "call_rev"), d, context()),
    ).resolves.toMatchObject({ action: "block", decidedBy: "rule" });
  });

  it("does not match an expired grant", async () => {
    const store = createMemoryStore();
    const d = descriptor("write", { name: "host_expired" });
    await seedGrant(store, { descriptor: d, expiresAt: "2020-01-01T00:00:00.000Z" });
    const guard = blockingGuard(store, "host_expired");

    await expect(
      guard.check(call("host_expired", { amount: 1 }, "call_exp"), d, context()),
    ).resolves.toMatchObject({ action: "block", decidedBy: "rule" });
  });
});

describe("loud grant invalidation", () => {
  const askingGuard = (store: ReturnType<typeof createMemoryStore>, tool: string) =>
    createGuard({ store, policy: { rules: [{ match: { tool }, action: "ask" }] } });

  it("parks a drifted grant with provenance and emits one invalidation audit event", async () => {
    const store = createMemoryStore();
    const stale = descriptor("write", { name: "host_drift_notice" });
    const current = descriptor("destructive", { name: "host_drift_notice" });
    const grant = await seedGrant(store, {
      descriptor: stale,
      id: "grt_drift_notice",
      grantedAt: "2026-07-01T12:00:00.000Z",
    });
    const guard = askingGuard(store, current.name);

    const decision = await guard.check(
      call(current.name, { amount: 1 }, "call_drift_notice"),
      current,
      context(),
    );

    expect(decision).toMatchObject({
      action: "ask",
      approval: {
        invalidatedGrant: { id: grant.id, grantedAt: grant.grantedAt },
      },
    });
    await expect(guard.approvals.pending(alice)).resolves.toEqual([
      expect.objectContaining({
        invalidatedGrant: { id: grant.id, grantedAt: grant.grantedAt },
      }),
    ]);

    const events = (await guard.audit.query({ principal: alice })).events.filter(
      (event) => event.kind === "policy-decision",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "policy-decision",
      outcome: "pending-approval",
      decidedBy: "default",
      tool: current.name,
      detail: {
        reason: "grant-invalidated",
        grantIds: [grant.id],
        tool: current.name,
        staleHash: grant.descriptorHash,
        currentHash: descriptorHash(current),
      },
    });
  });

  it("does not mark or audit an approval when no grant exists", async () => {
    const store = createMemoryStore();
    const current = descriptor("write", { name: "host_first_ask" });
    const guard = askingGuard(store, current.name);

    const decision = await guard.check(
      call(current.name, {}, "call_first_ask"),
      current,
      context(),
    );

    expect(decision).toMatchObject({ action: "ask" });
    if (decision.action !== "ask") throw new Error("expected approval");
    expect(decision.approval).not.toHaveProperty("invalidatedGrant");
    await expect(guard.audit.query({ principal: alice, kind: "policy-decision" })).resolves.toMatchObject({
      events: [],
    });
  });

  it("does not mark or audit a fresh matching grant", async () => {
    const store = createMemoryStore();
    const current = descriptor("write", { name: "host_fresh_grant" });
    await seedGrant(store, { descriptor: current });
    const guard = askingGuard(store, current.name);

    await expect(
      guard.check(call(current.name, {}, "call_fresh_grant"), current, context()),
    ).resolves.toMatchObject({ action: "run", decidedBy: "grant" });
    await expect(guard.approvals.pending(alice)).resolves.toEqual([]);
    await expect(guard.audit.query({ principal: alice, kind: "policy-decision" })).resolves.toMatchObject({
      events: [],
    });
  });

  it.each([
    { state: "revoked", revokedAt: "2026-07-01T12:00:00.000Z" },
    { state: "expired", expiresAt: "2020-01-01T00:00:00.000Z" },
  ])("does not treat a $state stale-hash grant as invalidated", async ({ revokedAt, expiresAt }) => {
    const store = createMemoryStore();
    const stale = descriptor("write", { name: "host_inactive_drift" });
    const current = descriptor("destructive", { name: "host_inactive_drift" });
    await seedGrant(store, { descriptor: stale, revokedAt, expiresAt });
    const guard = askingGuard(store, current.name);

    const decision = await guard.check(
      call(current.name, {}, `call_inactive_${revokedAt === undefined ? "expired" : "revoked"}`),
      current,
      context(),
    );

    expect(decision).toMatchObject({ action: "ask" });
    if (decision.action !== "ask") throw new Error("expected approval");
    expect(decision.approval).not.toHaveProperty("invalidatedGrant");
    await expect(guard.audit.query({ principal: alice, kind: "policy-decision" })).resolves.toMatchObject({
      events: [],
    });
  });
});
