import {
  VENDO_APP_FORMAT,
  descriptorHash,
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
  critical: true,
};

const ctx = (subject = "user_a"): RunContext => ({
  principal: { kind: "user", subject },
  venue: "chat",
  presence: "present",
  sessionId: `session_${subject}`,
});

const app = (
  id: string,
  trigger: NonNullable<AppDocument["trigger"]>,
  name = id,
): AppDocument => ({ format: VENDO_APP_FORMAT, id, name, trigger });

const seedApp = async (
  store: StoreAdapter,
  doc: AppDocument,
  subject = "user_a",
  enabled = false,
): Promise<void> => {
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject, enabled, doc },
    refs: { subject },
  });
};

class GuardDouble implements Guard {
  readonly audit: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

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

const storedRun = async (store: StoreAdapter, id: string): Promise<Record<string, unknown>> =>
  (await store.records("vendo_runs").get(id))?.data as Record<string, unknown>;

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

    const result = await engine.enable(doc.id, ctx());

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
    const { missing } = await engine.enable(doc.id, ctx());

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

  it("reuses live app-bound standing grants and preserves schedule cursors, webhook secrets, and disable state", async () => {
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
    expect((await engine.enable(schedule.id, ctx())).missing).toEqual([]);
    const cursor = await store.records("automations:schedule").get(schedule.id);
    expect(cursor?.data).toEqual({ lastFiredAt: NOW.toISOString() });
    await engine.disable(schedule.id, ctx());
    expect((await store.records("vendo_apps").get(schedule.id))?.data).toMatchObject({ enabled: false });
    expect(await store.records("automations:schedule").get(schedule.id)).toEqual(cursor);
  });
});

describe("steps execution, parking, and resumption", () => {
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

  it("parks the exact call, resumes it after approval, mints a grant, and continues", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let attempt = 0;
    let firstCall: ToolCall | undefined;
    const tools = registry([writeTool], async (call, runCtx) => {
      const currentAttempt = attempt++;
      if (currentAttempt === 0) {
        firstCall = structuredClone(call);
        const request = {
          id: "apr_park",
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
      }
      if (currentAttempt === 1) expect(call).toEqual(firstCall);
      return { status: "ok", output: "approved" };
    });
    const doc = app("app_park", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "needs", tool: writeTool.name, args: { value: "event.value" } },
        { id: "after", tool: writeTool.name, args: { value: "steps.needs" } },
      ] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", { value: 4 }, ctx().principal);

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "pending-approval" });
    expect((await storedRun(store, runId!)).record).toMatchObject({
      __resume: { stepIndex: 0, call: firstCall, approvalId: "apr_park", event: { value: 4 } },
    });
    await store.records("vendo_approvals").put({
      id: "apr_park",
      data: {
        ...((await store.records("vendo_approvals").get("apr_park"))?.data as object),
        status: "approved",
        decidedAt: NOW.toISOString(),
      },
    });
    guard.decide("apr_park", true);
    await flush();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "ok",
      summary: "2 steps ok",
      steps: [{ id: "needs", outcome: "ok" }, { id: "after", outcome: "ok" }],
    });
    expect((await store.records("vendo_grants").list()).records[0]?.data).toMatchObject({
      tool: writeTool.name, appId: doc.id, source: "automation",
    });
    expect(await store.records("automations:parked").get("apr_park")).toBeNull();
  });

  it("turns a denied parked call into a blocked hard failure and tick sweeps decided rows", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([writeTool], async (call, runCtx) => {
      const request = {
        id: "apr_deny",
        call,
        descriptor: writeTool,
        inputPreview: "write",
        ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
        createdAt: NOW.toISOString(),
      };
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      return { status: "pending-approval", approvalId: request.id };
    });
    const doc = app("app_deny", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "needs", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    const approval = await store.records("vendo_approvals").get("apr_deny");
    await store.records("vendo_approvals").put({
      id: "apr_deny",
      data: { ...(approval?.data as object), status: "denied", decidedAt: NOW.toISOString() },
    });

    await engine.tick();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "blocked", message: "the user declined the approval" },
      steps: [{ outcome: "blocked", detail: "user declined approval" }],
    });
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
    const schedules: Array<[string, NonNullable<AppDocument["trigger"]>["on"]]> = [
      ["app_cron", { kind: "schedule", cron: "* * * * *" }],
      ["app_every", { kind: "schedule", every: "15m" }],
      ["app_at", { kind: "schedule", at: "2026-07-12T10:00:00.000Z" }],
    ];
    for (const [appId, on] of schedules) {
      await seedApp(store, app(appId, { on, run: { kind: "steps", steps: [{ id: "run", tool: "fn:main", args: { event: "event" } }] } }), "user_a", true);
      await store.records("automations:schedule").put({
        id: appId,
        data: { lastFiredAt: "2026-07-12T08:00:00.000Z" },
      });
    }
    const engine = createAutomations({ apps, tools: registry(), guard, store, now: () => NOW });

    expect(await engine.tick()).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect((calls[0]?.args as { event: { firedAt: string } }).event.firedAt).toBe(NOW.toISOString());
    expect(await engine.tick()).toEqual([]);
    expect(calls).toHaveLength(3);
    expect((await store.records("automations:schedule").get("app_at"))?.data).toMatchObject({ firedAt: NOW.toISOString() });
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
    await engine.enable(external.id, ctx());
    const secret = ((await store.records("automations:webhook").get(external.id))?.data as { secret: string }).secret;
    const body = JSON.stringify({ answer: 42 });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_1", timestamp, body);
    const request = (sig: string, at = timestamp, delivery = "delivery_1") => new Request("https://example.test/api/webhooks/github", {
      method: "POST",
      headers: {
        "webhook-id": delivery,
        "webhook-timestamp": at,
        "webhook-signature": `v1,${sig}`,
      },
      body,
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
    expect(guard.audit.filter((event) => (event.detail as { status?: string }).status === "webhook-rejected")).toHaveLength(2);

    expect(await engine.emit("invoice.paid", { invoice: "inv_1" }, ctx().principal)).toHaveLength(1);
    expect(await engine.emit("invoice.paid", {}, ctx("other").principal)).toEqual([]);
    expect(observed).toContainEqual({ payload: { answer: 42 } });
    expect(observed).toContainEqual({ payload: { invoice: "inv_1" } });
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

    const plan = await engine.dryRun(doc.id, ctx(), { items: [1, 2] });

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
    let finish!: (value: Awaited<ReturnType<AgentRunner>>) => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const runner: AgentRunner = async () => {
      started();
      return await new Promise((resolve) => { finish = resolve; });
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
    finish({ status: "ok", summary: "too late", toolCalls: [] });
    await emitted;

    expect(await engine.runs.get(running.id, ctx())).toMatchObject({ status: "stopped", summary: "stopped by user", finishedAt: NOW.toISOString() });
    await expect(engine.runs.stop(running.id, ctx())).rejects.toMatchObject({ code: "conflict" });
    expect(guard.audit.map((event) => (event.detail as { status: string }).status)).toEqual(["running", "stopped"]);
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
