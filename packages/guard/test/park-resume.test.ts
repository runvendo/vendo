import type { ApprovalId } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard } from "../src/index.js";
import { createPGliteStore, type PGliteStore } from "./fixtures/pglite-store.js";
import { alice, bob, call, context, FixtureTools } from "./fixtures/tools.js";

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
