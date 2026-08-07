import {
  VENDO_APP_FORMAT,
  descriptorHash,
  triggerKindRefs,
  type AgentRunner,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type Json,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
  type Trigger,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAutomations } from "./index.js";

const NOW = new Date("2026-07-12T12:00:00.000Z");

const readTool: ToolDescriptor = {
  name: "read_data",
  description: "Read data",
  inputSchema: { type: "object" },
  risk: "read",
};

const writeTool: ToolDescriptor = {
  name: "write_data",
  description: "Write data",
  inputSchema: { type: "object" },
  risk: "write",
};

const criticalTool: ToolDescriptor = {
  name: "critical_action",
  description: "Do a critical action",
  inputSchema: { type: "object" },
  risk: "destructive",
  confirmEach: true,
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (
  id: string,
  trigger: Omit<Trigger, "id">,
  name = id,
): AppDocument => ({ format: VENDO_APP_FORMAT, id, name, triggers: [{ id: "main", ...trigger }] });

const seedApp = async (
  store: StoreAdapter,
  doc: AppDocument,
  subject = "user_a",
  enabled = false,
): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled, doc },
    // Mirror the reserved store's derived trigger-kind refs so the memory double the tests use
    // matches how the tick/emit filter apps in production.
    refs: { subject, ...triggerKindRefs(doc.triggers) },
  });
};

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  /** The optional spend seam (05 §2 amendment), scripted. Left unset by default
   *  so every existing case still exercises the pre-seam fallback path. */
  spendApproval?: (id: ApprovalId) => Promise<"spent" | "already-spent" | "taken-back">;
  /** Ids passed to {@link abandonApprovals}, in order. */
  readonly abandoned: ApprovalId[] = [];
  /** The store this double writes abandonment through, so a test can read the
   *  approval row back and see the ask actually closed rather than trusting that
   *  the seam was called. Set by the tests that exercise abandonment. */
  store?: StoreAdapter;
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  /** The real guard's contract in miniature: deny as `system` (never a
   *  standing no), idempotent, mint nothing, then fire the decision callbacks
   *  the same way an explicit denial does. */
  async abandonApprovals(ids: ApprovalId[]): Promise<void> {
    for (const id of ids) {
      this.abandoned.push(id);
      const record = await this.store?.records("vendo_approvals").get(id);
      if (record == null) continue;
      const data = record.data as Record<string, unknown>;
      if (data.status !== "pending") continue;
      await this.store!.records("vendo_approvals").put({
        id,
        data: { ...data, status: "denied", deniedBy: "system" },
      });
      for (const callback of this.callbacks) callback(id, false);
    }
  }

  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }

  async report(event: AuditEvent): Promise<void> {
    this.audit.push(structuredClone(event));
  }

  async directions(): Promise<string[]> { return []; }

  onApprovalDecision(callback: (id: ApprovalId, approved: boolean) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  decide(id: string, approved: boolean): void {
    for (const callback of this.callbacks) callback(id, approved);
  }
}

const registry = (
  descriptors: ToolDescriptor[] = [],
  execute: (call: ToolCall, runCtx: RunContext) => Promise<ToolOutcome> = async () => ({ status: "ok", output: {} }),
): ToolRegistry => ({
  async descriptors() { return descriptors; },
  execute,
});

const appsDouble = (
  call: AppsRuntime["call"] = async () => ({ status: "ok", output: {} }),
): AppsRuntime => ({ call } as AppsRuntime);

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

const memoryStoreWithoutAtomic = (): StoreAdapter => {
  const base = memoryStoreAdapter();
  return {
    ensureSchema: () => base.ensureSchema(),
    blobs: (namespace) => base.blobs(namespace),
    records(collection) {
      const records = base.records(collection);
      return {
        get: (id) => records.get(id),
        put: (record) => records.put(record),
        delete: (id) => records.delete(id),
        list: (query) => records.list(query),
      };
    },
  };
};

const sign = async (secret: string, deliveryId: string, timestamp: string, body: string): Promise<string> => {
  let normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
  normalized += "=".repeat((4 - normalized.length % 4) % 4);
  const keyBytes = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${deliveryId}.${timestamp}.${body}`)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

describe("automations enable and grant capture", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;

  beforeEach(() => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
  });

  it("computes the unique steps surface, excludes fn refs, and persists guard-compatible asks", async () => {
    const doc = app("app_steps_enable", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "a", tool: readTool.name },
        { id: "b", tool: "fn:local" },
        { id: "c", tool: readTool.name },
        { id: "d", tool: writeTool.name },
      ] },
    });
    await seedApp(store, doc);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry([readTool, writeTool]), guard, store, now: () => NOW,
    });

    const result = await engine.enable(doc.id, "main", ctx());

    expect(result.enabled).toBe(true);
    expect(result.missing.map((request) => request.call.tool)).toEqual([readTool.name, writeTool.name]);
    expect(result.missing[0]).toMatchObject({
      call: { id: expect.stringMatching(/^call_/), args: {} },
      descriptor: readTool,
      ctx: { principal: ctx().principal, venue: "automation", presence: "present", appId: doc.id },
      createdAt: NOW.toISOString(),
    });
    const approval = await store.records("vendo_approvals").get(result.missing[0]!.id);
    expect(approval?.data).toMatchObject({ request: result.missing[0], status: "pending" });
    expect(await store.records("automations:captures").get(result.missing[0]!.id)).toMatchObject({
      data: { appId: doc.id, subject: "user_a", tool: readTool.name, descriptorHash: descriptorHash(readTool) },
    });
  });

  it("captures every descriptor for agentic runs and mints or discards on decisions", async () => {
    const doc = app("app_agent_enable", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "do work" },
    });
    await seedApp(store, doc);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry([readTool, writeTool]), guard, store, now: () => NOW,
    });
    const { missing } = await engine.enable(doc.id, "main", ctx());

    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, false);
    await flush();

    const grants = await store.records("vendo_grants").list();
    expect(grants.records).toHaveLength(1);
    expect(grants.records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: readTool.name,
      descriptorHash: descriptorHash(readTool),
      scope: { kind: "tool" },
      duration: "standing",
      appId: doc.id,
      source: "automation",
      grantedAt: NOW.toISOString(),
    });
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.data).toMatchObject({
      consumedAt: NOW.toISOString(),
    });
    expect((await store.records("automations:captures").list()).records).toHaveLength(0);
  });

  it("ignores app-bound chat grants and preserves schedule cursors, webhook secrets, and disable state", async () => {
    const schedule = app("app_cursor", {
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    await seedApp(store, schedule);
    await store.records("vendo_grants").put({
      id: "grt_existing",
      data: {
        id: "grt_existing", subject: "user_a", tool: readTool.name,
        descriptorHash: descriptorHash(readTool), scope: { kind: "tool" }, duration: "standing",
        appId: schedule.id, source: "chat", grantedAt: NOW.toISOString(),
      },
      refs: { subject: "user_a", tool: readTool.name, app_id: schedule.id },
    });
    const engine = createAutomations({
      apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW,
    });
    expect((await engine.enable(schedule.id, "main", ctx())).missing.map(({ call }) => call.tool)).toEqual([readTool.name]);
    const cursor = await store.records("automations:schedule").get(`${schedule.id}:main`);
    expect(cursor?.data).toEqual({ lastFiredAt: NOW.toISOString() });
    await engine.disable(schedule.id, "main", ctx());
    expect((await store.records("vendo_apps").get(schedule.id))?.data).toMatchObject({ enabled: false });
    expect(await store.records("automations:schedule").get(`${schedule.id}:main`)).toEqual(cursor);
  });

  it("mints next-firing authority when an agentic run's approval is granted", async () => {
    const doc = app("app_agent_next", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "write later" },
    });
    await seedApp(store, doc, "user_a", true);
    // Constructing the engine is the whole subject here: that is what registers
    // the guard's onApprovalDecision callback the decision below travels through.
    createAutomations({
      apps: appsDouble(), tools: registry([writeTool]), guard, store, now: () => NOW,
    });
    const request = {
      id: "apr_agent_next",
      call: { id: "call_agent_next", tool: writeTool.name, args: { value: 1 } },
      descriptor: writeTool,
      inputPreview: "write",
      ctx: {
        principal: ctx().principal,
        venue: "automation" as const,
        presence: "away" as const,
        appId: doc.id,
        trigger: { runId: "run_agent", kind: "host-event" as const },
      },
      createdAt: NOW.toISOString(),
    };
    await store.records("vendo_approvals").put({
      id: request.id,
      data: { request, status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide(request.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: writeTool.name,
      appId: doc.id,
      source: "automation",
    });
    expect((await store.records("vendo_approvals").get(request.id))?.data).toMatchObject({
      consumedAt: NOW.toISOString(),
    });
  });
});

describe("grant sets: one set per enable, dedupe against pending, list projection", () => {
  let store: StoreAdapter;
  let guard: GuardDouble;

  // Mirrors the demo weeklySummaryDocument capture surface: two host reads.
  const insightsTool: ToolDescriptor = {
    name: "host_getSpendingInsights",
    description: "See category totals and month-over-month trends.",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const transactionsTool: ToolDescriptor = {
    name: "host_listTransactions",
    description: "Read transaction history across accounts.",
    inputSchema: { type: "object" },
    risk: "read",
  };
  const weekly = app("app_weekly_set", {
    on: { kind: "schedule", cron: "0 17 * * 5" },
    run: { kind: "steps", steps: [
      { id: "spending", tool: insightsTool.name },
      { id: "transactions", tool: transactionsTool.name },
    ] },
  }, "Weekly spending summary");

  const makeEngine = () => createAutomations({
    apps: appsDouble(), tools: registry([insightsTool, transactionsTool]), guard, store, now: () => NOW,
  });

  beforeEach(async () => {
    store = memoryStoreAdapter();
    guard = new GuardDouble();
    await seedApp(store, weekly);
  });

  it("returns one grantSetId spanning both missing asks and projects pendingGrants via list()", async () => {
    const engine = makeEngine();
    const result = await engine.enable(weekly.id, "main", ctx());

    expect(result.enabled).toBe(true);
    expect(result.missing).toHaveLength(2);
    expect(result.grantSetId).toEqual(expect.stringMatching(/^gset_/));
    for (const ask of result.missing) {
      expect((await store.records("automations:captures").get(ask.id))?.data).toMatchObject({
        appId: weekly.id,
        grantSetId: result.grantSetId,
      });
    }
    const listed = await engine.list(ctx());
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      triggers: [{ enabled: true, pendingGrants: 2, grantSetId: result.grantSetId }],
    });
  });

  it("re-running enable() reuses the pending ask — no duplicate ApprovalRequest per (appId, tool)", async () => {
    const engine = makeEngine();
    const first = await engine.enable(weekly.id, "main", ctx());
    guard.decide(first.missing[0]!.id, true);
    await flush();

    const second = await engine.enable(weekly.id, "main", ctx());

    expect(second.missing.map((ask) => ask.call.tool)).toEqual([transactionsTool.name]);
    expect(second.missing[0]!.id).toBe(first.missing[1]!.id);
    expect(second.grantSetId).toBe(first.grantSetId);
    const approvals = await store.records("vendo_approvals").list();
    const pendingForPair = approvals.records.filter((record) => {
      const data = record.data as { status?: string; request?: { call?: { tool?: string } } };
      return data.status === "pending" && data.request?.call?.tool === transactionsTool.name;
    });
    expect(pendingForPair).toHaveLength(1);
    expect((await engine.list(ctx()))[0]).toMatchObject({
      triggers: [{ pendingGrants: 1, grantSetId: first.grantSetId }],
    });
  });

  it("backward-compat: a legacy capture row without grantSetId still projects, and enable() adopts it into the set", async () => {
    // A pre-grant-sets deployment minted this ask: capture row with NO
    // grantSetId. New code must read it (schema optional), count it in the
    // projection, and adopt it on the next enable() instead of re-minting.
    const legacyRequest = {
      id: "apr_legacy",
      call: { id: "call_legacy", tool: insightsTool.name, args: {} },
      descriptor: insightsTool,
      inputPreview: "legacy standing ask",
      ctx: { principal: ctx().principal, venue: "automation" as const, presence: "present" as const, appId: weekly.id },
      createdAt: NOW.toISOString(),
    };
    await store.records("vendo_approvals").put({
      id: legacyRequest.id,
      data: { request: legacyRequest, status: "pending" },
    });
    await store.records("automations:captures").put({
      id: legacyRequest.id,
      data: { appId: weekly.id, triggerId: "main", subject: "user_a", tool: insightsTool.name, descriptorHash: descriptorHash(insightsTool) },
    });
    const engine = makeEngine();

    const listed = await engine.list(ctx());
    expect(listed[0]).toMatchObject({ triggers: [{ pendingGrants: 1 }] });
    expect(listed[0]?.triggers[0]?.grantSetId).toBeUndefined();

    const result = await engine.enable(weekly.id, "main", ctx());
    expect(result.missing.map((ask) => ask.id)).toEqual(["apr_legacy", result.missing[1]!.id]);
    expect(result.grantSetId).toEqual(expect.stringMatching(/^gset_/));
    expect((await store.records("automations:captures").get("apr_legacy"))?.data).toMatchObject({
      grantSetId: result.grantSetId,
    });
  });

  it("a fully denied set disarms the automation in the same decision — deny is transactional server-side", async () => {
    const engine = makeEngine();
    const { missing } = await engine.enable(weekly.id, "main", ctx());
    expect((await store.records("vendo_apps").get(weekly.id))?.data).toMatchObject({ enabled: true });

    guard.decide(missing[0]!.id, false);
    guard.decide(missing[1]!.id, false);
    await flush();

    // No second disable request exists to fail: the row disarmed with the
    // decision itself, no grants were minted, and the projection is clear.
    expect((await store.records("vendo_apps").get(weekly.id))?.data).toMatchObject({ enabled: false });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    const listed = await engine.list(ctx());
    expect(listed[0]).toMatchObject({ triggers: [{ enabled: false }] });
    expect(listed[0]?.triggers[0]?.pendingGrants).toBeUndefined();
  });

  it("a PARTIALLY granted automation stays armed on deny — the ungranted step fails loud at fire time (05 §6, J5)", async () => {
    const engine = makeEngine();
    const { missing } = await engine.enable(weekly.id, "main", ctx());

    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, false);
    await flush();

    // One grant landed, so the consent moment granted the automation
    // SOMETHING: the row keeps firing and the denied tool parks per run.
    expect((await store.records("vendo_apps").get(weekly.id))?.data).toMatchObject({ enabled: true });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
    const listed = await engine.list(ctx());
    expect(listed[0]).toMatchObject({ triggers: [{ enabled: true }] });
    expect(listed[0]?.triggers[0]?.pendingGrants).toBeUndefined();
  });

  it("deny order does not matter for partial grants: deny first, approve second still stays armed", async () => {
    const engine = makeEngine();
    const { missing } = await engine.enable(weekly.id, "main", ctx());

    guard.decide(missing[1]!.id, false);
    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_apps").get(weekly.id))?.data).toMatchObject({ enabled: true });
    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
  });

  it("clears the projection once every ask in the set is decided and omits grantSetId when nothing is missing", async () => {
    const engine = makeEngine();
    const { missing } = await engine.enable(weekly.id, "main", ctx());
    guard.decide(missing[0]!.id, true);
    guard.decide(missing[1]!.id, true);
    await flush();

    const listed = await engine.list(ctx());
    expect(listed[0]?.triggers[0]?.pendingGrants).toBeUndefined();
    expect(listed[0]?.triggers[0]?.grantSetId).toBeUndefined();

    const again = await engine.enable(weekly.id, "main", ctx());
    expect(again.missing).toHaveLength(0);
    expect(again.grantSetId).toBeUndefined();
  });

  /**
   * Checker round 5, finding 2 — arming a standing grant SPENDS the approval it
   * rode in on, so it has to contend with `approvals.revoke` on the same
   * one-time transition. The engine asks the guard for that spend and grants
   * only on "spent"; the two orderings of the race itself are pinned against the
   * real receipt in `packages/guard/test/ungraded-default.test.ts`.
   */
  it("arms nothing when the person took the yes back before the callback could spend it", async () => {
    const engine = makeEngine();
    guard.spendApproval = async () => "taken-back";
    const { missing } = await engine.enable(weekly.id, "main", ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
  });

  it("arms nothing when someone else already spent the yes", async () => {
    const engine = makeEngine();
    guard.spendApproval = async () => "already-spent";
    const { missing } = await engine.enable(weekly.id, "main", ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
  });

  it("arms exactly one grant per won spend, and leaves the approval row to the guard", async () => {
    const engine = makeEngine();
    guard.spendApproval = async () => "spent";
    const { missing } = await engine.enable(weekly.id, "main", ctx());

    guard.decide(missing[0]!.id, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(1);
    // The guard owns the row now: the engine no longer writes `consumedAt`
    // itself (which is what used to erase a concurrent take-back).
    expect((await store.records("vendo_approvals").get(missing[0]!.id))?.data)
      .not.toHaveProperty("consumedAt");
  });

  it("fallback for a Guard predating the seam: a taken-back yes arms nothing and keeps its marker", async () => {
    // No `spendApproval` on this double, so the engine takes the old write-back
    // path. It cannot linearize without a receipt, but it must still refuse the
    // take-back it can see — and must not strip `voidedAt`/`deniedBy` off the
    // row (the parse used to drop both).
    const engine = makeEngine();
    const { missing } = await engine.enable(weekly.id, "main", ctx());
    const takenBack = missing[0]!.id;
    const row = (await store.records("vendo_approvals").get(takenBack))?.data as Record<string, unknown>;
    await store.records("vendo_approvals").put({
      id: takenBack,
      data: { ...row, status: "approved", decidedAt: NOW.toISOString(), voidedAt: NOW.toISOString() },
    });

    guard.decide(takenBack, true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect((await store.records("vendo_approvals").get(takenBack))?.data).toMatchObject({
      voidedAt: NOW.toISOString(),
    });
  });
});

describe("steps execution and hard failures", () => {
  it("evaluates JSONata args, if, forEach, and cross-step outputs sequentially", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const calls: ToolCall[] = [];
    const tools = registry([readTool, writeTool], async (call) => {
      calls.push(structuredClone(call));
      const value = (call.args as { value: number }).value;
      return { status: "ok", output: value * 2 };
    });
    const doc = app("app_steps", {
      on: { kind: "host-event", event: "calculate" },
      run: { kind: "steps", steps: [
        { id: "first", tool: readTool.name, args: { value: "event.base" } },
        { id: "skip", tool: writeTool.name, if: "false" },
        { id: "fan", tool: writeTool.name, forEach: "event.items", args: { value: "item + steps.first" } },
      ] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });

    const [runId] = await engine.emit("calculate", { base: 3, items: [1, 2] }, ctx().principal);
    const run = await engine.runs.get(runId!, ctx());

    expect(calls.map((call) => call.args)).toEqual([{ value: 3 }, { value: 7 }, { value: 8 }]);
    expect(run).toMatchObject({ status: "ok", summary: "3 steps ok" });
    expect(run?.steps.map((step) => step.id)).toEqual(["first", "fan", "fan"]);
    expect(guard.audit.map((event) => event.detail)).toEqual([{ status: "running" }, { status: "ok" }]);
  });

  it("fails a run on connect-required with an actionable error and a readable step record", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([writeTool], async () => ({
      status: "connect-required",
      connect: { connector: "composio", toolkit: "gmail", message: "Connect your gmail account first." },
    }));
    const doc = app("app_connect", {
      on: { kind: "host-event", event: "send" },
      run: { kind: "steps", steps: [{ id: "send", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });

    const [runId] = await engine.emit("send", {}, ctx().principal);
    // The persisted record must READ BACK through the run schema — the step
    // outcome enum includes connect-required (an away run has no user to show
    // a connect card to; it fails with the actionable connect message).
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "connect-required", message: "Connect your gmail account first." },
      steps: [{ id: "send", outcome: "connect-required", detail: "Connect your gmail account first." }],
    });
  });

  it("contains oversized forEach fan-out", async () => {
    const store = memoryStoreAdapter();
    let calls = 0;
    const tools = registry([writeTool], async () => {
      calls += 1;
      return { status: "ok", output: {} };
    });
    const fanout = app("app_fanout_cap", {
      on: { kind: "host-event", event: "fan" },
      run: { kind: "steps", steps: [{ id: "fan", tool: writeTool.name, forEach: "event.items" }] },
    });
    await seedApp(store, fanout, "user_a", true);
    const engine = createAutomations({
      apps: appsDouble(), tools, guard: new GuardDouble(), store, now: () => NOW,
    });

    const [fanoutId] = await engine.emit("fan", { items: Array.from({ length: 1001 }, (_, index) => index) }, ctx().principal);
    expect(await engine.runs.get(fanoutId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "validation", message: "step fan forEach exceeds 1000 items" },
    });
    expect(calls).toBe(0);
  });

  it("keeps a stopped terminal row when a slow deterministic step returns", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const apps = appsDouble(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "ok", output: { late: true } };
    });
    const doc = app("app_slow_stop", {
      on: { kind: "host-event", event: "slow" },
      run: { kind: "steps", steps: [{ id: "slow", tool: "fn:slow" }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps, tools: registry(), guard, store, now: () => NOW });
    const controller = createAutomations({ apps, tools: registry(), guard, store, now: () => NOW });
    const emitted = engine.emit("slow", {}, ctx().principal);
    await didStart;
    const running = (await engine.runs.list({ status: "running" }, ctx())).runs[0]!;

    await controller.runs.stop(running.id, ctx());
    release();
    await emitted;

    expect(await engine.runs.get(running.id, ctx())).toMatchObject({ status: "stopped", summary: "stopped by user" });
    expect(guard.audit.map((event) => (event.detail as { status: string }).status)).toEqual(["running", "stopped"]);
  });
});

/** S2 — fail-loud consent. A run that meets a permission it does not hold
 *  stops LOUDLY at that step: the ask is captured (so the ONE existing decision
 *  path mints the standing grant), the run lands on a terminal `error` row
 *  naming what it needed, and the person taps Grant & re-run. Nothing is parked,
 *  nothing is resumed, nothing is replayed. */
describe("fail-loud consent and re-run", () => {
  /** A registry whose `write_data` answers pending-approval the first N times it
   *  is called — the guard's own answer for a call with no standing grant — and
   *  runs afterwards. Every call is recorded so a test can prove what executed. */
  const missingPermission = (store: StoreAdapter, misses = 1) => {
    const calls: ToolCall[] = [];
    let seen = 0;
    const tools = registry([readTool, writeTool], async (call, runCtx) => {
      calls.push(structuredClone(call));
      if (call.tool !== writeTool.name) return { status: "ok", output: { read: true } };
      seen += 1;
      if (seen > misses) return { status: "ok", output: "granted" };
      const request = {
        id: `apr_miss_${seen}`,
        call: structuredClone(call),
        descriptor: writeTool,
        inputPreview: "write",
        ctx: {
          principal: runCtx.principal,
          venue: runCtx.venue,
          presence: runCtx.presence,
          appId: runCtx.appId,
          trigger: runCtx.trigger,
        },
        createdAt: NOW.toISOString(),
      };
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      return { status: "pending-approval", approvalId: request.id };
    });
    return { tools, calls };
  };

  const twoStepApp = (id: string): AppDocument => app(id, {
    on: { kind: "host-event", event: "go" },
    run: { kind: "steps", steps: [
      { id: "read", tool: readTool.name },
      { id: "write", tool: writeTool.name, args: { value: "event.value" } },
      { id: "after", tool: readTool.name },
    ] },
  });

  it("stops the run at the missing permission, names the tool, and captures the ask", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools, calls } = missingPermission(store);
    const doc = twoStepApp("app_miss");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });

    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    // The run is TERMINAL and loud: a person can see what it needed and that
    // nothing after it ran.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission", tool: writeTool.name },
      steps: [
        { id: "read", outcome: "ok" },
        { id: "write", outcome: "pending-approval", detail: "apr_miss_1" },
      ],
    });
    expect((await engine.runs.get(runId!, ctx()))?.error?.message).toContain(writeTool.name);
    expect(calls.map((call) => call.tool)).toEqual([readTool.name, writeTool.name]);
    // …and the ask is a CAPTURE, the same shape arming writes, so the standing
    // grant is minted by the one decision path both doors share.
    const capture = await store.records("automations:captures").get("apr_miss_1");
    expect(capture?.data).toMatchObject({
      appId: doc.id,
      triggerId: "main",
      subject: "user_a",
      tool: writeTool.name,
      descriptorHash: descriptorHash(writeTool),
    });
    expect((capture?.data as { grantSetId?: string }).grantSetId).toMatch(/^gset_/);
    // The projection a surface renders "waiting on 1 permission" from.
    expect((await engine.list(ctx()))[0]?.triggers[0]).toMatchObject({ pendingGrants: 1 });
  });

  it("supersedes the arming ask with the away ask the run raised for the same permission", async () => {
    // The state a real deployment reaches constantly, and the one `seedApp`
    // cannot: the person armed the automation and left the consent card
    // undecided, so an arming ask for `write_data` is pending — and THEN the
    // schedule fired and the run met the same permission.
    //
    // One thing to allow is one question, so only one of the pair may stay
    // pending. WHICH one is not a toss-up. The away ask is raised inside the run
    // and carries `presence: "away"`, the `appId`, and its run id; the arming
    // ask is a present-time chat-venue row with none of that. Keeping the
    // arming one and closing the away one erases away provenance from the
    // approvals record — the thing every away-authority rule is enforced
    // against — so the away ask is the survivor and the arming ask is what
    // gets superseded.
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    guard.store = store;
    const { tools } = missingPermission(store);
    const doc = twoStepApp("app_orphan");
    await seedApp(store, doc, "user_a");
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });

    const { missing } = await engine.enable(doc.id, "main", ctx());
    const armingWrite = missing.find((request) => request.call.tool === writeTool.name);
    const armingRead = missing.find((request) => request.call.tool === readTool.name);
    expect(armingWrite).toBeDefined();
    expect(armingRead).toBeDefined();

    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);
    await flush();

    // The run still fails loudly for the right reason — that part was never wrong.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission", tool: writeTool.name },
    });

    // The AWAY ask survives, still pending, still answerable — it is the row a
    // surface renders the failed run's card from, and the only one that says
    // this permission was met while nobody was watching.
    expect(await store.records("vendo_approvals").get("apr_miss_1"))
      .toMatchObject({ data: { status: "pending" } });
    const away = (await store.records("vendo_approvals").get("apr_miss_1"))!.data as {
      request: { ctx: { presence?: string; appId?: string; venue?: string } };
    };
    expect(away.request.ctx).toMatchObject({ presence: "away", venue: "automation", appId: doc.id });

    // The redundant ARMING ask is the one closed, as `system` so it can never
    // read as the person having said no to this tool.
    expect(guard.abandoned).toEqual([armingWrite!.id]);
    expect(await store.records("vendo_approvals").get(armingWrite!.id))
      .toMatchObject({ data: { status: "denied", deniedBy: "system" } });

    // The capture MOVED rather than being dropped or duplicated: the question is
    // still outstanding, still in the same grant set, now keyed by the away ask.
    // A capture left on the closed arming ask would keep a settled question open;
    // no capture at all would orphan a pending ask no surface counts.
    const moved = await store.records("automations:captures").get("apr_miss_1");
    expect(moved?.data).toMatchObject({ appId: doc.id, triggerId: "main", tool: writeTool.name });
    expect(await store.records("automations:captures").get(armingWrite!.id)).toBeNull();

    // Still TWO questions outstanding (the untouched read ask + this one), never
    // three and never one: the count must not double-count the pair or orphan it.
    expect((await engine.list(ctx()))[0]?.triggers[0]).toMatchObject({ pendingGrants: 2 });
    expect(await store.records("vendo_approvals").get(armingRead!.id))
      .toMatchObject({ data: { status: "pending" } });
    // Superseding grants nothing, and the automation stays armed — a deny that
    // disarmed here would switch off an automation nobody said no to.
    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect((await engine.list(ctx()))[0]?.triggers[0]).toMatchObject({ enabled: true });
  });

  it("mints the standing grant on approval and re-runs the automation fresh", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools, calls } = missingPermission(store);
    const doc = twoStepApp("app_rerun");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    await store.records("vendo_approvals").put({
      id: "apr_miss_1",
      data: {
        ...((await store.records("vendo_approvals").get("apr_miss_1"))?.data as object),
        status: "approved",
        decidedAt: NOW.toISOString(),
      },
    });
    guard.decide("apr_miss_1", true);
    await flush();

    expect((await store.records("vendo_grants").list()).records[0]?.data).toMatchObject({
      subject: "user_a",
      tool: writeTool.name,
      appId: doc.id,
      triggerId: "main",
      source: "automation",
      duration: "standing",
    });
    expect(await store.records("automations:captures").get("apr_miss_1")).toBeNull();

    const rerunId = await engine.runs.rerun(runId!, ctx());

    // A FRESH run: its own row, its own id, the original triggering event.
    expect(rerunId).not.toBe(runId);
    expect(await engine.runs.get(rerunId, ctx())).toMatchObject({
      appId: doc.id,
      triggerId: "main",
      status: "ok",
      summary: "3 steps ok",
    });
    // The failed run stays exactly as it was — a re-run is a new attempt, not an
    // edit of the record of what happened.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "error" });
    // The write ran with the event of the run being re-run.
    expect(calls.at(-2)).toMatchObject({ tool: writeTool.name, args: { value: 4 } });
  });

  it("re-runs the trigger that FIRED, so editing the steps cannot move a completed call's identity", async () => {
    // The effect ledger tells "this call again" from "another call just like it"
    // by call id, and a steps call id is positional. That is only stable if the
    // re-run reads the same step list — so the re-run has to fire the definition
    // that actually fired, not whatever the document says now. Otherwise
    // inserting a step ahead of one that already completed renumbers it, its
    // receipt is never found, and work that already landed happens twice.
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools, calls } = missingPermission(store);
    const doc = twoStepApp("app_rerun_edited");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    // Step 0 completed before step 1 asked for a permission nobody held.
    const completed = calls.find((call) => call.tool === readTool.name);
    expect(completed).toBeDefined();

    await store.records("vendo_approvals").put({
      id: "apr_miss_1",
      data: {
        ...((await store.records("vendo_approvals").get("apr_miss_1"))?.data as object),
        status: "approved",
        decidedAt: NOW.toISOString(),
      },
    });
    guard.decide("apr_miss_1", true);
    await flush();

    // The author inserts a step AHEAD of the one that already ran, between the
    // failure and the re-run.
    await seedApp(store, app("app_rerun_edited", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "inserted", tool: readTool.name },
        { id: "read", tool: readTool.name },
        { id: "write", tool: writeTool.name, args: { value: "event.value" } },
        { id: "after", tool: readTool.name },
      ] },
    }), "user_a", true);

    const before = calls.length;
    await engine.runs.rerun(runId!, ctx());

    const rerunIds = calls.slice(before).map((call) => call.id);
    expect(rerunIds).toContain(completed!.id);
  });

  it("refuses a re-run for a caller who cannot edit the app, and an unknown run", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools } = missingPermission(store);
    const doc = twoStepApp("app_rerun_gate");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 1 }, ctx().principal);

    await expect(engine.runs.rerun(runId!, ctx("user_b"))).rejects.toMatchObject({ code: "not-found" });
    await expect(engine.runs.rerun("run_nope", ctx())).rejects.toMatchObject({ code: "not-found" });
  });

  it("refuses a re-run of a trigger nobody has armed", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools } = missingPermission(store);
    const doc = twoStepApp("app_rerun_off");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 1 }, ctx().principal);
    await engine.disable(doc.id, "main", ctx());

    await expect(engine.runs.rerun(runId!, ctx())).rejects.toMatchObject({ code: "conflict" });
  });

  it("mints nothing when the yes was taken back before the capture could spend it", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    guard.spendApproval = async () => "taken-back";
    const { tools } = missingPermission(store);
    await seedApp(store, twoStepApp("app_miss_takeback"), "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    guard.decide("apr_miss_1", true);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    // The run's own verdict is untouched by the decision either way.
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission" },
    });
  });

  it("leaves the run in error and mints nothing when the ask is denied", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const { tools } = missingPermission(store);
    await seedApp(store, twoStepApp("app_miss_deny"), "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    guard.decide("apr_miss_1", false);
    await flush();

    expect((await store.records("vendo_grants").list()).records).toHaveLength(0);
    expect(await store.records("automations:captures").get("apr_miss_1")).toBeNull();
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "needs-permission" },
    });
  });

  /** A row written while parking existed can never resume — park is gone. It
   *  reads back as the loud failure it always was, so one legacy row cannot make
   *  runs.list throw for a whole app. */
  it("reads a legacy parked run row back as an error", async () => {
    const store = memoryStoreAdapter();
    const doc = twoStepApp("app_legacy_parked");
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry([readTool, writeTool]), guard: new GuardDouble(), store, now: () => NOW,
    });
    const record = {
      id: "run_legacy",
      appId: doc.id,
      triggerId: "main",
      trigger: { kind: "host-event", event: "go" },
      status: "pending-approval",
      startedAt: NOW.toISOString(),
      steps: [{ id: "write", tool: writeTool.name, outcome: "pending-approval", at: NOW.toISOString() }],
      __resume: { stepIndex: 0, event: {}, stepOutputs: {}, call: { id: "call_x", tool: writeTool.name, args: {} }, approvalId: "apr_legacy" },
    };
    await store.records("vendo_runs").put({
      id: record.id,
      data: { appId: doc.id, trigger: record.trigger, status: "pending-approval", record, startedAt: record.startedAt },
      refs: { app_id: doc.id, status: "pending-approval" },
    });

    expect(await engine.runs.get("run_legacy", ctx())).toMatchObject({ status: "error" });
    expect((await engine.runs.list({ appId: doc.id }, ctx())).runs.map((run) => run.status)).toEqual(["error"]);
  });
});

describe("schedule, webhook, and host triggers", () => {
  it("fires due cron/every/at schedules once, collapses missed windows, and never backfills", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const calls: Array<{ appId: string; args: Json }> = [];
    const apps = appsDouble(async (appId, _ref, args) => {
      calls.push({ appId, args });
      return { status: "ok", output: {} };
    });
    const schedules: Array<[string, Trigger["on"]]> = [
      ["app_cron", { kind: "schedule", cron: "* * * * *" }],
      ["app_every", { kind: "schedule", every: "15m" }],
      ["app_at", { kind: "schedule", at: "2026-07-12T10:00:00.000Z" }],
    ];
    for (const [appId, on] of schedules) {
      await seedApp(store, app(appId, { on, run: { kind: "steps", steps: [{ id: "run", tool: "fn:main", args: { event: "event" } }] } }), "user_a", true);
      await store.records("automations:schedule").put({
        id: `${appId}:main`,
        data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
      });
    }
    const engine = createAutomations({ apps, tools: registry(), guard, store, now: () => NOW });
    const peer = createAutomations({ apps, tools: registry(), guard: new GuardDouble(), store, now: () => NOW });

    const [firstTick, secondTick] = await Promise.all([engine.tick(), peer.tick()]);
    expect([...firstTick, ...secondTick]).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect((calls[0]?.args as { event: { firedAt: string } }).event.firedAt).toBe(NOW.toISOString());
    expect(calls).toHaveLength(3);
    expect((await store.records("automations:schedule").get("app_at:main"))?.data).toMatchObject({ firedAt: NOW.toISOString() });
  });

  it("retains single-instance schedule behavior when the atomic capability is absent", async () => {
    const store = memoryStoreWithoutAtomic();
    const doc = app("app_schedule_fallback", {
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [] },
    });
    await seedApp(store, doc, "user_a", true);
    await store.records("automations:schedule").put({
      id: `${doc.id}:main`,
      data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
    });
    const engine = createAutomations({
      apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
    });

    await expect(engine.tick()).resolves.toHaveLength(1);
  });

  it.each([
    ["atomic", memoryStoreAdapter],
    ["non-atomic", memoryStoreWithoutAtomic],
  ])("initializes a future schedule cursor without firing via the %s store path", async (_path, createStore) => {
    const store = createStore();
    const doc = app("app_schedule_future", {
      on: { kind: "schedule", at: "2026-07-12T13:00:00.000Z" },
      run: { kind: "steps", steps: [] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
    });

    await expect(engine.tick()).resolves.toEqual([]);
    expect((await store.records("automations:schedule").get(`${doc.id}:main`))?.data).toEqual({
      lastFiredAt: NOW.toISOString(),
    });
  });

  it("atomically claims an uninitialized due schedule across engine instances", async () => {
    const store = memoryStoreAdapter();
    let calls = 0;
    const apps = appsDouble(async () => {
      calls += 1;
      return { status: "ok", output: {} };
    });
    const doc = app("app_schedule_first_claim", {
      on: { kind: "schedule", at: "2026-07-12T11:00:00.000Z" },
      run: { kind: "steps", steps: [{ id: "run", tool: "fn:main" }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps, tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    const peer = createAutomations({ apps, tools: registry(), guard: new GuardDouble(), store, now: () => NOW });

    const ticks = await Promise.all([engine.tick(), peer.tick()]);

    expect(ticks.flat()).toHaveLength(1);
    expect(calls).toBe(1);
    expect((await store.records("automations:schedule").get(`${doc.id}:main`))?.data).toEqual({
      lastFiredAt: NOW.toISOString(),
      firedAt: NOW.toISOString(),
    });
  });

  it("verifies HMAC vectors, dedupes deliveries, rejects bad/stale signatures once, and emits matching host events", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const observed: Json[] = [];
    const tools = registry([readTool], async (call) => {
      observed.push(call.args);
      return { status: "ok", output: {} };
    });
    const external = app("app_webhook", {
      on: { kind: "external", connector: "github", event: "push" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
    });
    const host = app("app_host", {
      on: { kind: "host-event", event: "invoice.paid" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
    });
    await seedApp(store, external);
    await seedApp(store, host, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const peer = createAutomations({ apps: appsDouble(), tools, guard: new GuardDouble(), store, now: () => NOW });
    await engine.enable(external.id, "main", ctx());
    const secret = ((await store.records("automations:webhook").get(`${external.id}:main`))?.data as { secret: string }).secret;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_1", timestamp, body);
    const request = (sig: string, at = timestamp, delivery = "delivery_1", requestBody = body) => new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": delivery,
        "webhook-timestamp": at,
        "webhook-signature": `v1,${sig}`,
      },
      body: requestBody,
    });

    const valid = await engine.webhook(request(signature));
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    const duplicate = await engine.webhook(request(signature));
    expect(await duplicate.json()).toEqual({ deduped: true });
    const bad = await engine.webhook(request("AAAA", timestamp, "delivery_bad"));
    expect(bad.status).toBe(401);
    expect(await bad.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });
    const staleTimestamp = String(NOW.getTime() / 1_000 - 301);
    const stale = await engine.webhook(request(await sign(secret, "delivery_stale", staleTimestamp, body), staleTimestamp, "delivery_stale"));
    expect(stale.status).toBe(401);
    const invalidJson = "{not-json";
    const unverifiedInvalid = await engine.webhook(request("AAAA", timestamp, "delivery_invalid_bad", invalidJson));
    expect(unverifiedInvalid.status).toBe(401);
    const verifiedInvalid = await engine.webhook(request(
      await sign(secret, "delivery_invalid_ok", timestamp, invalidJson),
      timestamp,
      "delivery_invalid_ok",
      invalidJson,
    ));
    expect(verifiedInvalid.status).toBe(400);
    const auditsBeforeSize = guard.audit.length;
    const oversized = await engine.webhook(request(
      "AAAA",
      timestamp,
      "delivery_oversized",
      "x".repeat(1024 * 1024 + 1),
    ));
    expect(oversized.status).toBe(413);
    // Oversized rejections audit like every other unverified-input rejection.
    expect(guard.audit).toHaveLength(auditsBeforeSize + 1);
    expect(guard.audit.filter((event) => (event.detail as { status?: string }).status === "webhook-rejected")).toHaveLength(4);

    const concurrentBody = JSON.stringify({ concurrent: true });
    const concurrentSignature = await sign(secret, "delivery_concurrent", timestamp, concurrentBody);
    const concurrent = await Promise.all([
      engine.webhook(request(concurrentSignature, timestamp, "delivery_concurrent", concurrentBody)),
      peer.webhook(request(concurrentSignature, timestamp, "delivery_concurrent", concurrentBody)),
    ]);
    expect(concurrent.map(({ status }) => status)).toEqual([200, 200]);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(2);

    expect(await engine.emit("invoice.paid", { invoice: "inv_1" }, ctx().principal)).toHaveLength(1);
    expect(await engine.emit("invoice.paid", {}, ctx("other").principal)).toEqual([]);
    expect(observed).toContainEqual({ payload: { answer: 42 } });
    expect(observed).toContainEqual({ payload: { invoice: "inv_1" } });
  });

  it("dedupes webhook deliveries when the store lacks atomic claims", async () => {
    const store = memoryStoreWithoutAtomic();
    const external = app("app_webhook_fallback", {
      on: { kind: "external", connector: "github", event: "push" },
      run: { kind: "steps", steps: [] },
    });
    await seedApp(store, external);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
    });
    await engine.enable(external.id, "main", ctx());
    const secret = ((await store.records("automations:webhook").get(`${external.id}:main`))?.data as { secret: string }).secret;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const deliveryId = "delivery_fallback";
    const signature = await sign(secret, deliveryId, timestamp, body);
    const request = () => new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": deliveryId,
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    });

    const first = await engine.webhook(request());
    const duplicate = await engine.webhook(request());

    expect(await first.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
    expect(await duplicate.json()).toEqual({ deduped: true });
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
    expect((await store.records("automations:deliveries").get(`${external.id}:main:${deliveryId}`))?.data).toEqual({
      appId: external.id,
      triggerId: "main",
      deliveryId,
      receivedAt: NOW.toISOString(),
    });
  });

  it("refs the schedule cursor, webhook secret, and delivery to their app so app erase collects them", async () => {
    const store = memoryStoreAdapter();
    const external = app("app_refs_webhook", {
      on: { kind: "external", connector: "github", event: "push" },
      run: { kind: "steps", steps: [] },
    });
    const scheduled = app("app_refs_schedule", {
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [] },
    });
    await seedApp(store, external);
    await seedApp(store, scheduled);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
    });
    await engine.enable(external.id, "main", ctx());
    await engine.enable(scheduled.id, "main", ctx());
    const secret = ((await store.records("automations:webhook").get(`${external.id}:main`))?.data as { secret: string }).secret;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_refs", timestamp, body);
    await engine.webhook(new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": "delivery_refs",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    }));

    expect((await store.records("automations:webhook").get(`${external.id}:main`))?.refs)
      .toEqual({ app_id: external.id });
    expect((await store.records("automations:deliveries").get(`${external.id}:main:delivery_refs`))?.refs)
      .toEqual({ app_id: external.id });
    expect((await store.records("automations:schedule").get(`${scheduled.id}:main`))?.refs)
      .toEqual({ app_id: scheduled.id });
  });

  it("refs a schedule cursor the tick itself writes, on both the claiming and the not-yet-due path", async () => {
    const store = memoryStoreAdapter();
    const due = app("app_refs_tick_due", {
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [] },
    });
    const future = app("app_refs_tick_future", {
      on: { kind: "schedule", at: "2026-07-12T13:00:00.000Z" },
      run: { kind: "steps", steps: [] },
    });
    await seedApp(store, due, "user_a", true);
    await seedApp(store, future, "user_a", true);
    // No cursor rows yet: the tick is what writes both, and the app row alone
    // is what an erase would otherwise leave them behind from.
    const engine = createAutomations({
      apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
    });

    await engine.tick();

    expect((await store.records("automations:schedule").get(`${due.id}:main`))?.refs)
      .toEqual({ app_id: due.id });
    expect((await store.records("automations:schedule").get(`${future.id}:main`))?.refs)
      .toEqual({ app_id: future.id });
  });
});

// Under the hosted store, Vendo Cloud's own scheduler and Composio
// delivery already fire schedule/external automations for the deployment — the local engine
// composed alongside it must not ALSO fire them (double-run). `localTriggerKinds` scopes which
// trigger kinds this engine instance fires; host-event (vendo.emit) is never gated by it.
describe("localTriggerKinds: deferring schedule/external firing to another authority (Cloud)", () => {
  it("skips due schedule apps on tick, keeps the [] response shape, launches nothing, and leaves the cursor untouched for the other authority", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let calls = 0;
    const apps = appsDouble(async () => {
      calls += 1;
      return { status: "ok", output: {} };
    });
    const doc = app("app_cloud_schedule", {
      on: { kind: "schedule", every: "15m" },
      run: { kind: "steps", steps: [{ id: "run", tool: "fn:main" }] },
    });
    await seedApp(store, doc, "user_a", true);
    await store.records("automations:schedule").put({
      id: `${doc.id}:main`,
      data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
    });
    const engine = createAutomations({
      apps, tools: registry(), guard, store, now: () => NOW,
      localTriggerKinds: new Set(),
    });

    await expect(engine.tick()).resolves.toEqual([]);
    expect(calls).toBe(0);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(0);
    expect((await store.records("automations:schedule").get(`${doc.id}:main`))?.data).toEqual({
      lastFiredAt: "2026-07-12T08:00:00.000Z",
    });
  });

  it("answers a validly-signed external delivery with a deferred-to-Cloud no-op, launching no run and reporting no rejection", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([readTool], async () => ({ status: "ok", output: {} }));
    const external = app("app_cloud_webhook", {
      on: { kind: "external", connector: "github", event: "push" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
    });
    await seedApp(store, external);
    const engine = createAutomations({
      apps: appsDouble(), tools, guard, store, now: () => NOW,
      localTriggerKinds: new Set(),
    });
    await engine.enable(external.id, "main", ctx());
    const secret = ((await store.records("automations:webhook").get(`${external.id}:main`))?.data as { secret: string }).secret;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_1", timestamp, body);
    const request = new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": "delivery_1",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    });

    const response = await engine.webhook(request);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deferred: true });
    expect((await store.records("vendo_runs").list()).records).toHaveLength(0);
    expect(guard.audit.filter((event) => (event.detail as { status?: string }).status === "webhook-rejected")).toHaveLength(0);
  });

  it("still fires host-event automations via emit exactly as before", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([readTool], async () => ({ status: "ok", output: {} }));
    const host = app("app_cloud_host", {
      on: { kind: "host-event", event: "invoice.paid" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name, args: { payload: "event" } }] },
    });
    await seedApp(store, host, "user_a", true);
    const engine = createAutomations({
      apps: appsDouble(), tools, guard, store, now: () => NOW,
      localTriggerKinds: new Set(),
    });

    const ids = await engine.emit("invoice.paid", { invoice: "inv_1" }, ctx().principal);

    expect(ids).toHaveLength(1);
    expect((await store.records("vendo_runs").list()).records).toHaveLength(1);
  });

  // Cloud-audit fix 3. A fn: step is an HTTP call into the APP's own sandbox
  // machine (packages/apps/src/fn.ts POSTs /fn/<name>), so the authority that
  // fires the trigger is the one that has to wake and reach that machine. When
  // this engine defers firing to Cloud, whether Cloud can do that is not
  // knowable here — so the operator hears about it at the arming point, which
  // is the only place that sees both the trigger kind and the steps.
  describe("fn: steps deferred to another firing authority warn at enable()", () => {
    const enableWithWarn = async (
      doc: AppDocument,
      localTriggerKinds?: ReadonlySet<"schedule" | "external">,
    ): Promise<string[]> => {
      const store = memoryStoreAdapter();
      await seedApp(store, doc);
      const engine = createAutomations({
        apps: appsDouble(), tools: registry([readTool]), guard: new GuardDouble(), store, now: () => NOW,
        ...(localTriggerKinds === undefined ? {} : { localTriggerKinds }),
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        await engine.enable(doc.id, "main", ctx());
        return warn.mock.calls
          .map(([message]) => (typeof message === "string" ? message : ""))
          .filter((message) => message.includes("fn: steps"));
      } finally {
        warn.mockRestore();
      }
    };

    it("warns, naming the app and the deferred trigger kind", async () => {
      const warns = await enableWithWarn(app("app_fn_cloud", {
        on: { kind: "schedule", every: "15m" },
        run: { kind: "steps", steps: [{ id: "run", tool: "fn:main" }] },
      }, "Weekly digest"), new Set());

      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("Weekly digest");
      expect(warns[0]).toContain("schedule");
      expect(warns[0]).toContain("sandbox machine");
    });

    it("stays silent for a deferred automation whose steps are all host tools", async () => {
      expect(await enableWithWarn(app("app_tools_cloud", {
        on: { kind: "external", connector: "github", event: "push" },
        run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
      }), new Set())).toEqual([]);
    });

    it("stays silent when this engine fires the trigger itself — the machine is one it wakes", async () => {
      expect(await enableWithWarn(app("app_fn_local", {
        on: { kind: "schedule", every: "15m" },
        run: { kind: "steps", steps: [{ id: "run", tool: "fn:main" }] },
      }))).toEqual([]);
    });

    it("stays silent for host-event automations, which are never deferred", async () => {
      expect(await enableWithWarn(app("app_fn_host", {
        on: { kind: "host-event", event: "invoice.paid" },
        run: { kind: "steps", steps: [{ id: "run", tool: "fn:main" }] },
      }), new Set())).toEqual([]);
    });
  });
});

describe("dry runs, run visibility, agentic execution, and stopping", () => {
  it("previews concrete steps without persistence and reports critical asks separately from missing grants", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_preview", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "fan", tool: readTool.name, forEach: "event.items" },
        { id: "critical", tool: criticalTool.name },
        { id: "machine", tool: "fn:main" },
      ] },
    });
    await seedApp(store, doc);
    const engine = createAutomations({
      apps: appsDouble(), tools: registry([readTool, criticalTool]), guard, store, now: () => NOW,
    });
    const beforeApprovals = await store.records("vendo_approvals").list();

    const plan = await engine.dryRun(doc.id, "main", ctx(), { items: [1, 2] });

    expect(plan.steps).toEqual([
      { id: "fan", tool: readTool.name, wouldAsk: true },
      { id: "fan", tool: readTool.name, wouldAsk: true },
      { id: "critical", tool: criticalTool.name, wouldAsk: true },
      { id: "machine", tool: "fn:main", wouldAsk: false },
    ]);
    expect(plan.grantsMissing).toEqual([readTool.name]);
    expect(await store.records("vendo_approvals").list()).toEqual(beforeApprovals);
    expect((await store.records("automations:captures").list()).records).toHaveLength(0);
  });

  it("surfaces a scheduler-refused run (pricing v3 §5) as a failed run carrying the blocked reason", async () => {
    // Under a hosted store, Cloud's scheduler is the firing authority for
    // schedule/external automations and writes run rows with the same shape
    // this engine writes (writeRun). A run it refused at the meter gate must
    // read back as a plain failed run — the refusal's own reason and code
    // intact — wherever OSS renders run status. No client-side checks: the
    // record is the truth.
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_blocked", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "read", tool: readTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const blockedReason =
      "blocked by allowance: Vendo Cloud paused automation runs — the allowance for this billing "
      + "period is used up (1,050 of 1,000 used; resets 2026-08-01). "
      + "Upgrade your plan (https://console.vendo.run/billing) "
      + "or bring your own infrastructure (https://docs.vendo.run/byo).";
    const record = {
      id: "run_blocked",
      appId: doc.id,
      triggerId: "main",
      trigger: { kind: "schedule" as const },
      status: "error" as const,
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      steps: [],
      summary: "blocked by allowance",
      error: { code: "meter-exhausted", message: blockedReason },
    };
    await store.records("vendo_runs").put({
      id: record.id,
      data: {
        appId: record.appId,
        trigger: record.trigger,
        status: record.status,
        record,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
      },
      refs: { app_id: record.appId, status: record.status },
    });
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW });

    expect(await engine.runs.get("run_blocked", ctx())).toMatchObject({
      status: "error",
      error: { code: "meter-exhausted", message: blockedReason },
    });
    const listed = await engine.runs.list({ appId: doc.id, status: "error" }, ctx());
    expect(listed.runs).toMatchObject([{ id: "run_blocked", error: { code: "meter-exhausted" } }]);
    // Still owner-scoped like any other run.
    expect(await engine.runs.get("run_blocked", ctx("other"))).toBeNull();
  });

  it("runs agentic work with default budget 50, scopes records to owners, and reports unavailable runners", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const budgets: Array<number | undefined> = [];
    const runner: AgentRunner = async (task) => {
      budgets.push(task.budget?.maxToolCalls);
      return {
        status: "ok",
        summary: "agent finished",
        toolCalls: [{ call: { id: "call_agent", tool: readTool.name, args: {} }, outcome: "ok" }],
      };
    };
    const doc = app("app_agent_run", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "work" },
    });
    const absent = app("app_agent_absent", {
      on: { kind: "host-event", event: "missing" },
      run: { kind: "agentic", prompt: "work" },
    });
    await seedApp(store, doc, "user_a", true);
    await seedApp(store, absent, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, runner, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);

    expect(budgets).toEqual([50]);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "ok", summary: "agent finished", steps: [{ id: "call_agent", tool: readTool.name, outcome: "ok", at: NOW.toISOString() }],
    });
    expect(await engine.runs.get(runId!, ctx("other"))).toBeNull();
    expect((await engine.runs.list({}, ctx("other"))).runs).toEqual([]);
    expect((await engine.runs.list({ appId: doc.id, status: "ok" }, ctx())).runs).toHaveLength(1);

    const unavailable = createAutomations({ apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
    const [missingId] = await unavailable.emit("missing", {}, ctx().principal);
    expect(await unavailable.runs.get(missingId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "not-implemented", message: "agentic runs unavailable" },
    });
  });

  it("marks an in-flight agentic run stopped, discards the late result, and rejects terminal stops", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let receivedSignal: AbortSignal | undefined;
    const runner: AgentRunner = async (task) => {
      receivedSignal = task.abortSignal;
      started();
      return await new Promise((resolve) => {
        task.abortSignal?.addEventListener("abort", () => resolve({
          status: "stopped", summary: "aborted", toolCalls: [],
        }), { once: true });
      });
    };
    const doc = app("app_stop", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "wait" },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, runner, now: () => NOW });
    const emitted = engine.emit("go", {}, ctx().principal);
    await didStart;
    const running = (await engine.runs.list({ status: "running" }, ctx())).runs[0]!;

    await engine.runs.stop(running.id, ctx());
    await emitted;

    expect(receivedSignal?.aborted).toBe(true);
    expect(await engine.runs.get(running.id, ctx())).toMatchObject({ status: "stopped", summary: "stopped by user", finishedAt: NOW.toISOString() });
    await expect(engine.runs.stop(running.id, ctx())).rejects.toMatchObject({ code: "conflict" });
    expect(guard.audit.map((event) => (event.detail as { status: string }).status)).toEqual(["running", "stopped"]);
  });

  it("start survives a failing tick without an unhandled rejection", async () => {
    vi.useFakeTimers();
    const rejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const base = memoryStoreAdapter();
      // A store hiccup (or a corrupt row) makes every runTick reject.
      const store: StoreAdapter = {
        ensureSchema: () => base.ensureSchema(),
        blobs: (namespace) => base.blobs(namespace),
        records: (collection) => ({
          ...base.records(collection),
          list: async () => { throw new Error("store unavailable"); },
        }),
      };
      const engine = createAutomations({
        apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW,
      });
      const stop = engine.start(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      stop();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
      vi.useRealTimers();
    }
  });

  it("start skips overlapping ticks and returned stop functions are independent", async () => {
    vi.useFakeTimers();
    try {
      const store = memoryStoreAdapter();
      const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard: new GuardDouble(), store, now: () => NOW });
      const stopA = engine.start(1_000);
      const stopB = engine.start(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      stopA();
      stopB();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
