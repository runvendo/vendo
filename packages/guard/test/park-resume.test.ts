import { canonicalJson, sha256Hex } from "@vendoai/core";
import type { ApprovalId } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, bob, call, context, descriptor, FixtureTools } from "./fixtures/tools.js";

const stores: PGliteStore[] = [];

async function store(): Promise<PGliteStore> {
  const value = await createPGliteStore();
  stores.push(value);
  return value;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((value) => value.close()));
});

function guardedConfig(sqlStore: PGliteStore) {
  return {
    store: sqlStore,
    policy: { rules: [{ match: { risk: "destructive" as const }, action: "ask" as const }] },
  };
}

describe("approval park and resume over the real SQL mapping", () => {
  it("parks, approves, resumes the exact call once, then consumes that approval", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const ctx = context({
      venue: "automation",
      presence: "away",
      appId: "app_1",
      trigger: { runId: "run_1", kind: "schedule" },
    });
    const destructive = call("host_destructive", { invoiceId: "inv_1" }, "call_once");

    const parked = await bound.execute(destructive, ctx);
    expect(parked).toMatchObject({ status: "pending-approval" });
    if (parked.status !== "pending-approval") throw new Error("expected parked call");

    const approvalRow = await sqlStore.query<{ status: string; session_id: string }>(
      "SELECT status, session_id FROM vendo_approvals WHERE id = $1",
      [parked.approvalId],
    );
    expect(approvalRow.rows).toEqual([{ status: "pending", session_id: "session_1" }]);

    const pending = await guard.approvals.pending(alice);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: parked.approvalId,
      call: destructive,
      inputPreview: 'host_destructive {"invoiceId":"inv_1"}',
    });

    const callback = vi.fn();
    const unsubscribe = guard.onApprovalDecision(callback);
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);
    expect(callback).toHaveBeenCalledWith(parked.approvalId, true);

    await expect(bound.execute(destructive, ctx)).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
    const consumed = await sqlStore.query<{ consumed_at: Date | string | null }>(
      "SELECT consumed_at FROM vendo_approvals WHERE id = $1",
      [parked.approvalId],
    );
    expect(consumed.rows[0]?.consumed_at).not.toBeNull();

    await expect(bound.execute(destructive, ctx)).resolves.toMatchObject({
      status: "pending-approval",
    });
    expect(tools.executions).toHaveLength(1);
    unsubscribe();
  });

  it("never resumes a call whose tool or args differ from the approved request", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);

    const parked = await bound.execute(call("host_destructive", { invoiceId: "inv_1" }, "call_replay"), context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Same caller-minted call id, different args: must re-park, not run.
    await expect(
      bound.execute(call("host_destructive", { invoiceId: "inv_999" }, "call_replay"), context()),
    ).resolves.toMatchObject({ status: "pending-approval" });
    // Same id, different tool: must re-park, not run.
    await expect(
      bound.execute(call("host_write", { invoiceId: "inv_1" }, "call_replay"), context()),
    ).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);

    // The genuine call still resumes exactly once.
    await expect(
      bound.execute(call("host_destructive", { invoiceId: "inv_1" }, "call_replay"), context()),
    ).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("ignores forged inputHash/inputPreview on remembered exact scopes", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_destructive", { invoiceId: "inv_real" }, "call_forge"), context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");

    await guard.approvals.decide(
      parked.approvalId,
      {
        approve: true,
        remember: {
          scope: {
            kind: "exact",
            inputHash: "sha256:forged-covers-something-else",
            inputPreview: "host_destructive {\"invoiceId\":\"innocent\"}",
          },
          duration: "standing",
        },
      },
      alice,
    );

    const [grant] = await guard.grants.list(alice);
    expect(grant?.scope).toEqual({
      kind: "exact",
      inputHash: `sha256:${sha256Hex(canonicalJson({ invoiceId: "inv_real" }))}`,
      inputPreview: 'host_destructive {"invoiceId":"inv_real"}',
    });
  });

  it("mints an app-bound standing grant and routes it into vendo_grants", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const ctx = context({ venue: "app", appId: "app_1" });
    const destructive = call("host_destructive", { invoiceId: "inv_2" }, "call_grant");

    const parked = await bound.execute(destructive, ctx);
    if (parked.status !== "pending-approval") throw new Error("expected parked call");
    await guard.approvals.decide(
      parked.approvalId,
      { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } },
      alice,
    );

    const grants = await sqlStore.query<{
      subject: string;
      tool: string;
      source: string;
      app_id: string | null;
    }>("SELECT subject, tool, source, app_id FROM vendo_grants");
    expect(grants.rows).toEqual([
      { subject: alice.subject, tool: "host_destructive", source: "chat", app_id: "app_1" },
    ]);
    await expect(bound.execute(call("host_destructive", { invoiceId: "inv_3" }, "call_new"), ctx)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("decides batches sequentially and mints batch-sourced exact grants", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const bound = guard.bind(new FixtureTools());
    const first = await bound.execute(call("host_destructive", { n: 1 }, "batch_1"), context());
    const second = await bound.execute(call("host_destructive", { n: 2 }, "batch_2"), context());
    if (first.status !== "pending-approval" || second.status !== "pending-approval") {
      throw new Error("expected both calls to park");
    }

    await guard.approvals.decide(
      [first.approvalId, second.approvalId],
      { approve: true, remember: { scope: { kind: "exact" } as never, duration: "session" } },
      alice,
    );

    const approvals = await sqlStore.query<{ id: string; status: string }>(
      "SELECT id, status FROM vendo_approvals ORDER BY id",
    );
    expect(approvals.rows).toEqual([
      { id: first.approvalId, status: "approved" },
      { id: second.approvalId, status: "approved" },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    const grants = await sqlStore.query<{
      source: string;
      context_key: string;
      scope: { kind: string; inputHash: string; inputPreview: string };
    }>("SELECT source, context_key, scope FROM vendo_grants ORDER BY id");
    expect(grants.rows).toHaveLength(2);
    for (const row of grants.rows) {
      expect(row).toMatchObject({ source: "batch", context_key: "session_1", scope: { kind: "exact" } });
      expect(row.scope.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(row.scope.inputPreview).toContain("host_destructive");
    }
  });

  it("never resumes an approval in a different context (present-approved, away-replayed)", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const presentCtx = context({ venue: "chat", presence: "present" });
    const c = call("host_destructive", { invoiceId: "inv_ctx" }, "call_ctx");

    const parked = await bound.execute(c, presentCtx);
    if (parked.status !== "pending-approval") throw new Error("expected parked call");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Same call + subject, but now away in an automation: must not consume the
    // present-context approval — away execution needs app-bound authority.
    const awayCtx = context({ venue: "automation", presence: "away", appId: "app_1", trigger: { runId: "run_ctx", kind: "schedule" } });
    await expect(bound.execute(c, awayCtx)).resolves.toMatchObject({ status: "pending-approval" });
    expect(tools.executions).toHaveLength(0);

    // The genuine present resume still runs once.
    await expect(bound.execute(c, presentCtx)).resolves.toMatchObject({ status: "ok" });
    expect(tools.executions).toHaveLength(1);
  });

  it("never resumes when the tool's descriptor changed after parking (read→destructive)", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const readDesc = descriptor("read", { name: "host_flip" });
    const destructiveDesc = descriptor("destructive", { name: "host_flip" });
    const tools = new FixtureTools([readDesc]);
    const bound = guard.bind(tools);
    const c = call("host_flip", { q: 1 }, "call_flip");

    const parked = await bound.execute(c, context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Registry now serves the same name as a destructive tool: the frozen
    // descriptor no longer matches, so the approval must not authorize it.
    const flipped = new FixtureTools([destructiveDesc]);
    const flippedBound = guard.bind(flipped);
    await expect(flippedBound.execute(c, context())).resolves.toMatchObject({ status: "pending-approval" });
    expect(flipped.executions).toHaveLength(0);
  });

  it("consumes a single-use approval exactly once under concurrent resume", async () => {
    const sqlStore = await store();
    const guard = createGuard({
      store: sqlStore,
      policy: { rules: [{ match: {}, action: "ask" }] },
    });
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const c = call("host_destructive", { invoiceId: "inv_race" }, "call_race");

    const parked = await bound.execute(c, context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");
    await guard.approvals.decide(parked.approvalId, { approve: true }, alice);

    // Fire two resumes concurrently: exactly one must run, one must re-park.
    const [a, b] = await Promise.all([bound.execute(c, context()), bound.execute(c, context())]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["ok", "pending-approval"]);
    expect(tools.executions).toHaveLength(1);
  });

  it("serializes concurrent approve+deny on one approval to a single decision", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_destructive", { n: 1 }, "call_ad"), context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");

    const results = await Promise.allSettled([
      guard.approvals.decide(parked.approvalId, { approve: true, remember: { scope: { kind: "tool" }, duration: "standing" } }, alice),
      guard.approvals.decide(parked.approvalId, { approve: false }, alice),
    ]);
    // Exactly one wins; the other conflicts.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const rows = await sqlStore.query<{ status: string }>("SELECT status FROM vendo_approvals WHERE id = $1", [parked.approvalId]);
    expect(rows.rows).toHaveLength(1);
    expect(["approved", "denied"]).toContain(rows.rows[0]?.status);
    // If deny won, there is no grant; if approve won, exactly one — never a
    // live grant orphaned by a denial.
    const grants = await sqlStore.query<{ id: string }>("SELECT id FROM vendo_grants");
    expect(grants.rows.length).toBe(rows.rows[0]?.status === "approved" ? 1 : 0);
  });

  it("refuses to mint grants whose matches constraints are unsafe regexes", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const bound = guard.bind(new FixtureTools());
    const parked = await bound.execute(call("host_destructive", { memo: "x" }, "call_unsafe"), context());
    if (parked.status !== "pending-approval") throw new Error("expected parked call");

    await expect(
      guard.approvals.decide(
        parked.approvalId,
        {
          approve: true,
          remember: {
            scope: {
              kind: "constrained",
              constraints: [{ path: "/memo", op: "matches", value: "^(a+)+$" }],
            },
            duration: "standing",
          },
        },
        alice,
      ),
    ).rejects.toMatchObject({ code: "validation" });
    const grants = await sqlStore.query<{ id: string }>("SELECT id FROM vendo_grants");
    expect(grants.rows).toEqual([]);
  });

  it("denials notify false, do not resume, and another subject cannot decide", async () => {
    const sqlStore = await store();
    const guard = createGuard(guardedConfig(sqlStore));
    const tools = new FixtureTools();
    const bound = guard.bind(tools);
    const first = await bound.execute(call("host_destructive", {}, "deny_1"), context());
    const second = await bound.execute(call("host_destructive", {}, "isolate_1"), context());
    if (first.status !== "pending-approval" || second.status !== "pending-approval") {
      throw new Error("expected calls to park");
    }

    const callback = vi.fn();
    guard.onApprovalDecision(callback);
    await guard.approvals.decide(first.approvalId, { approve: false }, alice);
    expect(callback).toHaveBeenCalledWith(first.approvalId, false);
    await expect(bound.execute(call("host_destructive", {}, "deny_1"), context())).resolves.toMatchObject({
      status: "pending-approval",
    });

    await expect(
      guard.approvals.decide(second.approvalId as ApprovalId, { approve: true }, bob),
    ).rejects.toMatchObject({ code: "not-found" });
    const row = await sqlStore.query<{ status: string }>(
      "SELECT status FROM vendo_approvals WHERE id = $1",
      [second.approvalId],
    );
    expect(row.rows).toEqual([{ status: "pending" }]);
  });
});
