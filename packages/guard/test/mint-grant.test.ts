/**
 * The guard's ONE mint, driven through the REAL store on both ends: minted
 * through `mintGrant`, read back through the very grant lookup `check()` asks
 * its authority question from. Nothing stubbed between them — the mint and the
 * lookup disagreeing is exactly the failure a shared implementation exists to
 * make impossible.
 */
import {
  DEFAULT_TRIGGER_ID,
  type ApprovalRequest,
  type GrantId,
  type MintGrantInput,
  type ToolDescriptor,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createGuard } from "../src/index.js";
import { createMemoryStore, type MemoryStore } from "./fixtures/memory-store.js";
import { alice, call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

const askWrites = { rules: [{ match: { risk: "write" as const }, action: "ask" as const }] };

function guardOf(store: MemoryStore) {
  return createGuard({ store, policy: askWrites });
}

/** Optional on the interface (the `spendApproval` shape — hand-written guards
 *  predate it); always present on the one this package builds. */
const mint = (guard: ReturnType<typeof guardOf>, input: MintGrantInput): Promise<GrantId> =>
  guard.mintGrant!(input);

async function grantRow(store: MemoryStore, id: string) {
  const record = await store.records("vendo_grants").get(id);
  if (record === null) throw new Error(`grant ${id} was never written`);
  return record;
}

function approval(overrides: Partial<ApprovalRequest["ctx"]> = {}, tool: ToolDescriptor = descriptor("write")): ApprovalRequest {
  return {
    id: "apr_mint",
    call: call(tool.name, { value: 1 }, "call_mint"),
    descriptor: tool,
    inputPreview: "value: 1",
    ctx: { principal: alice, venue: "chat", presence: "present", sessionId: "session_1", ...overrides },
    createdAt: new Date().toISOString(),
  };
}

describe("guard.mintGrant — the one grant write", () => {
  it("writes the row AND the refs a ref-trusting adapter filters on", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);

    const id = await mint(guard, {
      request: approval({ appId: "app_1", presence: "away", venue: "automation" }),
      remember: { duration: "standing" },
      source: "automation",
      triggerId: "nightly",
    });

    const record = await grantRow(store, id);
    // A reserved grants table derives its own refs from the row's columns; what
    // this pins is that the mint hands it a row those columns can be read off.
    expect(record.refs).toMatchObject({ subject: alice.subject, tool: "host_write", app_id: "app_1" });
    expect(record.data).toMatchObject({
      scope: { kind: "tool" },
      duration: "standing",
      source: "automation",
      appId: "app_1",
      triggerId: "nightly",
    });
  });

  it("a minted automation grant is the authority an AWAY run of that trigger runs on", async () => {
    // The seam, not a shape assertion: the mint is only correct if the guard's
    // own away check honors what it wrote — same app, same trigger, source
    // "automation" (05 §6).
    const store = createMemoryStore();
    const guard = guardOf(store);
    const write = descriptor("write");
    const away = context({ presence: "away", venue: "automation", appId: "app_1", trigger: { id: "nightly", kind: "schedule", runId: "run_1" } });

    await mint(guard, {
      request: approval({ appId: "app_1", presence: "away", venue: "automation" }),
      remember: { duration: "standing" },
      source: "automation",
      triggerId: "nightly",
    });

    await expect(guard.check(call("host_write", { value: 2 }, "call_away"), write, away))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });
  });

  it("a SIBLING trigger of the same app never rides that yes", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const write = descriptor("write");

    await mint(guard, {
      request: approval({ appId: "app_1", presence: "away", venue: "automation" }),
      remember: { duration: "standing" },
      source: "automation",
      triggerId: "nightly",
    });

    const sibling = context({
      presence: "away",
      venue: "automation",
      appId: "app_1",
      trigger: { id: "hourly", kind: "schedule", runId: "run_2" },
    });
    await expect(guard.check(call("host_write", { value: 2 }, "call_sibling"), write, sibling))
      .resolves.toMatchObject({ action: "ask" });
    // …and an app-wide grant (no trigger) still answers for the default one.
    await mint(guard, {
      request: approval({ appId: "app_2", presence: "away", venue: "automation" }),
      remember: { duration: "standing" },
      source: "automation",
    });
    const legacy = context({
      presence: "away",
      venue: "automation",
      appId: "app_2",
      trigger: { id: DEFAULT_TRIGGER_ID, kind: "schedule", runId: "run_3" },
    });
    await expect(guard.check(call("host_write", { value: 2 }, "call_legacy"), write, legacy))
      .resolves.toMatchObject({ action: "run", decidedBy: "grant" });
  });
});

describe("the decide path mints through it", () => {
  it("a remembered yes lands one grant with the parked conversation's key and the chat source", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { value: 1 }, "call_remember"), context());
    if (parked.status !== "pending-approval") throw new Error("expected a parked write");

    await guard.approvals.decide(
      parked.approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "session" } },
      alice,
    );

    const [grant, ...extra] = await guard.grants.list(alice);
    expect(extra).toEqual([]);
    expect(grant).toMatchObject({
      subject: alice.subject,
      tool: "host_write",
      scope: { kind: "tool" },
      duration: "session",
      contextKey: "session_1",
      source: "chat",
    });
    expect((await grantRow(store, grant!.id)).refs).toEqual({ subject: alice.subject, tool: "host_write" });
  });

  it("an `exact` remember is still re-derived from the approved request, never from the caller", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_write", { value: 7 }, "call_exact"), context());
    if (parked.status !== "pending-approval") throw new Error("expected a parked write");

    await guard.approvals.decide(
      parked.approvalId,
      {
        approve: true,
        // A wire caller's lie about what it authorizes.
        remember: { scope: { kind: "exact", inputHash: "attacker", inputPreview: "something harmless" }, duration: "standing" },
      },
      alice,
    );

    const [grant] = await guard.grants.list(alice);
    expect(grant?.scope).toMatchObject({ kind: "exact" });
    expect(grant?.scope).not.toMatchObject({ inputHash: "attacker" });
    expect((grant?.scope as { inputPreview: string }).inputPreview).toContain("7");
  });

  it("a SET decision mints every member with the batch source", async () => {
    const store = createMemoryStore();
    const guard = guardOf(store);
    const bound = guard.bind(new FixtureTools());
    const ids: string[] = [];
    for (const id of ["call_batch_a", "call_batch_b"]) {
      const parked = await bound.execute(call("host_write", { value: 1 }, id), context());
      if (parked.status !== "pending-approval") throw new Error("expected a parked write");
      ids.push(parked.approvalId);
    }

    await guard.approvals.decide(
      ids,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    const grants = await guard.grants.list(alice);
    expect(grants).toHaveLength(2);
    expect(grants.every((grant) => grant.source === "batch")).toBe(true);
  });
});
