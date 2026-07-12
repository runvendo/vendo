import { describe, expect, it } from "vitest";
import { createGuard } from "../../src/index.js";
import { createMemoryStore } from "../fixtures/memory-store.js";
import { call, context, descriptor, seedGrant } from "../fixtures/tools.js";

// 05 §2 stage 3: a grant matches only an unrevoked, unexpired grant whose
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
