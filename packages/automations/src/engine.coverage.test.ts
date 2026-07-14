/** Coverage-closing tests for engine.ts — mirrors engine.test.ts's helpers and
 * only asserts on the PUBLIC AutomationsEngine surface (createAutomations),
 * never on private internals, so a concurrent perf refactor of scheduling/tick
 * internals cannot break these on implementation details alone.
 */
import {
  VENDO_APP_FORMAT,
  descriptorHash,
  type AgentRunner,
  type AppDocument,
  type AuditEvent,
  type ApprovalId,
  type Guard,
  type Json,
  type RecordStore,
  type RunContext,
  type StoreAdapter,
  type ToolCall,
  type ToolDescriptor,
  type ToolOutcome,
  type ToolRegistry,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { describe, expect, it } from "vitest";
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

/** Wraps a store so a single named collection's RecordStore.get() pauses on a
 * gate — lets a test deterministically park one async caller mid-flight
 * without touching engine internals. */
const delayedGetStore = (
  base: StoreAdapter,
  collection: string,
  onStart: () => void,
  gate: Promise<void>,
): StoreAdapter => ({
  ensureSchema: () => base.ensureSchema(),
  blobs: (namespace) => base.blobs(namespace),
  records(name: string): RecordStore {
    const inner = base.records(name);
    if (name !== collection) return inner;
    return {
      ...inner,
      async get(id) {
        onStart();
        await gate;
        return await inner.get(id);
      },
    };
  },
});

/** A minimal, schema-valid parked+run pair seeded directly so tests can drive
 * resumeRun's edge branches without running a full steps pipeline first. */
const seedRunRow = async (
  store: StoreAdapter,
  runId: string,
  appId: string,
  status: "running" | "ok" | "error" | "stopped" | "pending-approval",
): Promise<void> => {
  const record = {
    id: runId,
    appId,
    trigger: { kind: "host-event" as const, event: "go" },
    status,
    startedAt: NOW.toISOString(),
    finishedAt: status === "running" || status === "pending-approval" ? undefined : NOW.toISOString(),
    steps: [],
    summary: status === "ok" ? "0 steps ok" : undefined,
  };
  await store.records("vendo_runs").put({
    id: runId,
    data: {
      appId,
      trigger: record.trigger,
      status,
      record,
      startedAt: record.startedAt,
      ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }),
    },
    refs: { app_id: appId, status },
  });
};

describe("validateTrigger schedule format errors", () => {
  it("rejects an every duration, a malformed cron field count, and cron values croner cannot parse", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const badEvery = app("app_bad_every", {
      on: { kind: "schedule", every: "bogus" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    await seedApp(store, badEvery);
    await expect(engine.enable(badEvery.id, ctx())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("schedule every must match"),
    });

    const badCronFields = app("app_bad_cron_fields", {
      on: { kind: "schedule", cron: "* * * *" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    await seedApp(store, badCronFields);
    await expect(engine.enable(badCronFields.id, ctx())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("exactly 5 fields"),
    });

    const badCronSyntax = app("app_bad_cron_syntax", {
      on: { kind: "schedule", cron: "99 * * * *" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    await seedApp(store, badCronSyntax);
    await expect(engine.enable(badCronSyntax.id, ctx())).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("invalid schedule cron"),
    });
  });
});

describe("direct tool failures terminate the run without an approval detour", () => {
  it("surfaces a direct error outcome and a direct blocked outcome through errorForOutcome", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const errorDoc = app("app_direct_error", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "fails", tool: writeTool.name }] },
    });
    const blockedDoc = app("app_direct_blocked", {
      on: { kind: "host-event", event: "block" },
      run: { kind: "steps", steps: [{ id: "blocked", tool: writeTool.name }] },
    });
    await seedApp(store, errorDoc, "user_a", true);
    await seedApp(store, blockedDoc, "user_a", true);
    const tools = registry([writeTool], async (call) => call.tool === writeTool.name
      ? { status: "error", error: { code: "boom", message: "tool broke" } }
      : { status: "ok", output: {} });
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });

    const [errorRunId] = await engine.emit("go", {}, ctx().principal);
    expect(await engine.runs.get(errorRunId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "boom", message: "tool broke" },
      steps: [{ id: "fails", outcome: "error", detail: "tool broke" }],
    });

    const blockedTools = registry([writeTool], async () => ({ status: "blocked", reason: "not allowed" }));
    const blockedEngine = createAutomations({ apps: appsDouble(), tools: blockedTools, guard, store, now: () => NOW });
    const [blockedRunId] = await blockedEngine.emit("block", {}, ctx().principal);
    expect(await blockedEngine.runs.get(blockedRunId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "blocked", message: "not allowed" },
      steps: [{ id: "blocked", outcome: "blocked", detail: "not allowed" }],
    });
  });

  it("fails a step whose args expression itself throws, separately from a forEach/if failure", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_bad_args", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "badargs", tool: writeTool.name, args: { value: "$notarealfunction(1,2)" } },
      ] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry([writeTool]), guard, store, now: () => NOW });

    const [runId] = await engine.emit("go", {}, ctx().principal);

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "validation" },
      steps: [{ id: "badargs", outcome: "error" }],
    });
  });
});

describe("agentic runner throws instead of returning an error report", () => {
  it("terminates the run as not-implemented when the runner rejects", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const runner: AgentRunner = async () => { throw new Error("agent crashed"); };
    const doc = app("app_agent_throws", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "work" },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, runner, now: () => NOW });

    const [runId] = await engine.emit("go", {}, ctx().principal);

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      summary: "agent crashed",
      error: { code: "not-implemented", message: "agent crashed" },
    });
  });
});

describe("webhook signature edge cases", () => {
  it("rejects non-base64 signature candidates, a zero-length secret key, and an oversized content-length header up front", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([readTool], async () => ({ status: "ok", output: {} }));
    const malformedBase64Doc = app("app_webhook_badb64", {
      on: { kind: "external", connector: "conn_badb64", event: "push" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
    });
    const emptySecretDoc = app("app_webhook_emptysecret", {
      on: { kind: "external", connector: "conn_emptysecret", event: "push" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
    });
    await seedApp(store, malformedBase64Doc);
    await seedApp(store, emptySecretDoc);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    await engine.enable(malformedBase64Doc.id, ctx());
    await engine.enable(emptySecretDoc.id, ctx());
    // Force a zero-length HMAC key: crypto.subtle rejects it, exercising verifySignature's own catch.
    await store.records("automations:webhook").put({ id: emptySecretDoc.id, data: { secret: "" } });

    const body = "{}";
    const timestamp = String(NOW.getTime() / 1_000);
    const makeRequest = (connector: string, signature: string, headers: Record<string, string> = {}) => new Request(`https://example.test/api/webhooks/${connector}`, {
      method: "POST",
      headers: {
        "webhook-id": "delivery_edge",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
        ...headers,
      },
      body,
    });

    const badBase64 = await engine.webhook(makeRequest("conn_badb64", "!!!not-base64!!!"));
    expect(badBase64.status).toBe(401);
    expect(await badBase64.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });

    const emptySecret = await engine.webhook(makeRequest("conn_emptysecret", "AAAA"));
    expect(emptySecret.status).toBe(401);
    expect(await emptySecret.json()).toEqual({ error: { code: "blocked", message: "webhook signature verification failed" } });

    const oversizedHeader = await engine.webhook(makeRequest("conn_badb64", "AAAA", { "content-length": String(1024 * 1024 * 2) }));
    expect(oversizedHeader.status).toBe(413);
    expect(await oversizedHeader.json()).toEqual({ error: { code: "validation", message: "webhook body exceeds 1 MiB" } });
  });

  it("dedupes a second delivery arriving while the first is still in flight, before either touches persisted delivery rows", async () => {
    const base = memoryStoreAdapter();
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const store = delayedGetStore(base, "automations:deliveries", () => started(), gate);
    const guard = new GuardDouble();
    const tools = registry([readTool], async () => ({ status: "ok", output: {} }));
    const doc = app("app_inflight_dedupe", {
      on: { kind: "external", connector: "conn_inflight", event: "push" },
      run: { kind: "steps", steps: [{ id: "handle", tool: readTool.name }] },
    });
    await seedApp(store, doc);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    await engine.enable(doc.id, ctx());
    const secret = ((await store.records("automations:webhook").get(doc.id))?.data as { secret: string }).secret;
    const body = JSON.stringify({ ok: true });
    const timestamp = String(NOW.getTime() / 1_000);
    const signature = await sign(secret, "delivery_inflight", timestamp, body);
    const makeRequest = () => new Request("https://example.test/api/webhooks/conn_inflight", {
      method: "POST",
      headers: {
        "webhook-id": "delivery_inflight",
        "webhook-timestamp": timestamp,
        "webhook-signature": `v1,${signature}`,
      },
      body,
    });

    const first = engine.webhook(makeRequest());
    await didStart;
    const second = await engine.webhook(makeRequest());
    expect(await second.json()).toEqual({ deduped: true });

    release();
    const firstResult = await first;
    expect(await firstResult.json()).toMatchObject({ runIds: [expect.stringMatching(/^run_/)] });
  });
});

describe("liveGrant recognizes a matching standing automation grant", () => {
  it("excludes a tool from missing approvals when a live matching grant already exists", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_live_grant", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    await seedApp(store, doc);
    await store.records("vendo_grants").put({
      id: "grt_live",
      data: {
        id: "grt_live",
        subject: "user_a",
        tool: readTool.name,
        descriptorHash: descriptorHash(readTool),
        scope: { kind: "tool" },
        duration: "standing",
        appId: doc.id,
        source: "automation",
        grantedAt: NOW.toISOString(),
      },
      refs: { subject: "user_a", tool: readTool.name, app_id: doc.id },
    });
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW });

    const { missing } = await engine.enable(doc.id, ctx());

    expect(missing).toEqual([]);
  });
});

describe("concurrent runs.stop calls race the same terminal write", () => {
  it("only audits the stop once when the second stop's write lands after the first already terminated the row", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const apps = appsDouble(async () => {
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "ok", output: {} };
    });
    const doc = app("app_race_stop", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "slow", tool: "fn:slow" }] },
    });
    await seedApp(store, doc, "user_a", true);
    // Both concurrent runs.stop() calls read the run row as "running" (passing
    // runsStop's own conflict check) before either writes. To deterministically
    // land the SECOND call's internal writeRun() after the FIRST call's write —
    // exercising writeRun's own stale-terminal race guard rather than the
    // earlier conflict check — gate each of the two `vendo_apps` reads (the
    // ownedApp/appRecord lookup runsStop makes between its status check and its
    // terminal() write) individually, releasing them in a controlled order.
    const appsGetGateResolvers: Array<() => void> = [];
    const appsGetGates = [0, 1].map((index) => new Promise<void>((resolve) => { appsGetGateResolvers[index] = resolve; }));
    let appsGetCount = 0;
    const racingStore: StoreAdapter = {
      ensureSchema: () => store.ensureSchema(),
      blobs: (namespace) => store.blobs(namespace),
      records(name: string): RecordStore {
        const inner = store.records(name);
        if (name !== "vendo_apps") return inner;
        return {
          ...inner,
          async get(id) {
            const index = appsGetCount;
            appsGetCount += 1;
            if (index < appsGetGates.length) await appsGetGates[index];
            return await inner.get(id);
          },
        };
      },
    };
    const engine = createAutomations({ apps, tools: registry(), guard, store: racingStore, now: () => NOW });
    const emitted = engine.emit("go", {}, ctx().principal);
    await didStart;
    // Read the running row straight off the (unwrapped) store — engine.runs.list
    // would itself consume one of the two gated `vendo_apps` reads via its own
    // ownership check, throwing off the count before the race even starts.
    const runningId = (await store.records("vendo_runs").list({ refs: { status: "running" } })).records[0]!.id;

    const firstStop = engine.runs.stop(runningId, ctx());
    const secondStop = engine.runs.stop(runningId, ctx());
    // Let both calls reach their (paused) appRecord lookup before releasing either.
    await flush();
    appsGetGateResolvers[0]!();
    await firstStop;
    appsGetGateResolvers[1]!();
    await expect(secondStop).resolves.toBeUndefined();
    release();
    await emitted;

    expect((await store.records("vendo_runs").get(runningId))?.data).toMatchObject({
      status: "stopped",
      record: { summary: "stopped by user" },
    });
    expect(guard.audit.filter((event) => (event.detail as { status?: string }).status === "stopped")).toHaveLength(1);
  });
});

describe("resumeRun edge branches", () => {
  it("cleans up a parked row pointing at a run that no longer exists", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });
    await store.records("automations:parked").put({ id: "apr_ghost", data: { runId: "run_missing" } });

    guard.decide("apr_ghost", true);
    await flush();

    expect(await store.records("automations:parked").get("apr_ghost")).toBeNull();
    void engine;
  });

  it("discards a decision for a parked row whose run has already reached a terminal status", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });
    await seedRunRow(store, "run_already_done", "app_whatever", "ok");
    await store.records("automations:parked").put({ id: "apr_stale", data: { runId: "run_already_done" } });

    guard.decide("apr_stale", true);
    await flush();

    expect(await store.records("automations:parked").get("apr_stale")).toBeNull();
    const stored = (await store.records("vendo_runs").get("run_already_done"))?.data as { status: string };
    expect(stored.status).toBe("ok");
    void engine;
  });

  it("stops instead of resuming when the app was deleted before the decision arrives", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([writeTool], async (call, runCtx) => {
      const request = {
        id: "apr_app_gone",
        call,
        descriptor: writeTool,
        inputPreview: "write",
        ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
        createdAt: NOW.toISOString(),
      };
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      return { status: "pending-approval", approvalId: request.id };
    });
    const doc = app("app_gone_resume", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "write", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    await store.records("vendo_apps").delete(doc.id);
    const approval = await store.records("vendo_approvals").get("apr_app_gone");
    await store.records("vendo_approvals").put({
      id: "apr_app_gone",
      data: { ...(approval?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide("apr_app_gone", true);
    await flush();

    // The app row is gone, so runs.get's ownership check can no longer resolve
    // it — read the persisted run row directly instead.
    expect((await store.records("vendo_runs").get(runId!))?.data).toMatchObject({
      status: "stopped",
      record: { summary: "app deleted before resume" },
    });
    expect(await store.records("automations:parked").get("apr_app_gone")).toBeNull();
  });

  it("re-parks a resumed step that asks for approval again, then resolves it on the next decision", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let attempt = 0;
    const tools = registry([writeTool], async (call, runCtx) => {
      attempt += 1;
      const request = {
        id: attempt === 1 ? "apr_first" : "apr_second",
        call,
        descriptor: writeTool,
        inputPreview: "write",
        ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
        createdAt: NOW.toISOString(),
      };
      if (attempt <= 2) {
        await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
        return { status: "pending-approval", approvalId: request.id };
      }
      return { status: "ok", output: "done" };
    });
    const doc = app("app_reparks", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "needs", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "pending-approval" });

    const approveFirst = await store.records("vendo_approvals").get("apr_first");
    await store.records("vendo_approvals").put({
      id: "apr_first",
      data: { ...(approveFirst?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });
    guard.decide("apr_first", true);
    await flush();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "pending-approval",
      steps: [{ id: "needs", outcome: "pending-approval", detail: "apr_second" }],
    });

    const approveSecond = await store.records("vendo_approvals").get("apr_second");
    await store.records("vendo_approvals").put({
      id: "apr_second",
      data: { ...(approveSecond?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });
    guard.decide("apr_second", true);
    await flush();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "ok",
      steps: [{ id: "needs", outcome: "ok" }],
    });
  });

  it("continues a parked forEach iteration after approval, accumulating outputs across the remaining items", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let attempt = 0;
    const calls: Json[] = [];
    const tools = registry([writeTool], async (call, runCtx) => {
      attempt += 1;
      calls.push(call.args);
      if (attempt === 1) {
        const request = {
          id: "apr_foreach",
          call,
          descriptor: writeTool,
          inputPreview: "write",
          ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
          createdAt: NOW.toISOString(),
        };
        await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
        return { status: "pending-approval", approvalId: request.id };
      }
      const value = (call.args as { value: number }).value;
      return { status: "ok", output: value * 10 };
    });
    const doc = app("app_foreach_park", {
      on: { kind: "host-event", event: "fan" },
      run: { kind: "steps", steps: [
        { id: "fan", tool: writeTool.name, forEach: "event.items", args: { value: "item" } },
      ] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("fan", { items: [1, 2, 3] }, ctx().principal);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "pending-approval" });

    const approval = await store.records("vendo_approvals").get("apr_foreach");
    await store.records("vendo_approvals").put({
      id: "apr_foreach",
      data: { ...(approval?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });
    guard.decide("apr_foreach", true);
    await flush();

    // resumeRun re-executes the parked call itself (item 0) before continuing
    // the remaining forEach iterations (items 1 and 2).
    expect(calls).toEqual([{ value: 1 }, { value: 1 }, { value: 2 }, { value: 3 }]);
    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "ok", summary: "3 steps ok" });
  });

  it("discards a resumed call's late result once the run was stopped mid-resume", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let attempt = 0;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const tools = registry([writeTool], async (call, runCtx) => {
      attempt += 1;
      if (attempt === 1) {
        const request = {
          id: "apr_stop_mid_resume",
          call,
          descriptor: writeTool,
          inputPreview: "write",
          ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
          createdAt: NOW.toISOString(),
        };
        await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
        return { status: "pending-approval", approvalId: request.id };
      }
      started();
      await new Promise<void>((resolve) => { release = resolve; });
      return { status: "ok", output: "late" };
    });
    const doc = app("app_stop_mid_resume", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "needs", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    const approval = await store.records("vendo_approvals").get("apr_stop_mid_resume");
    await store.records("vendo_approvals").put({
      id: "apr_stop_mid_resume",
      data: { ...(approval?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide("apr_stop_mid_resume", true);
    await didStart;
    await engine.runs.stop(runId!, ctx());
    release();
    await flush();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({ status: "stopped", summary: "stopped by user" });
  });

  it("terminates the run in error when the resumed call itself fails, distinct from a user decline", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    let attempt = 0;
    const tools = registry([writeTool], async (call, runCtx) => {
      attempt += 1;
      if (attempt === 1) {
        const request = {
          id: "apr_resume_fails",
          call,
          descriptor: writeTool,
          inputPreview: "write",
          ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
          createdAt: NOW.toISOString(),
        };
        await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
        return { status: "pending-approval", approvalId: request.id };
      }
      return { status: "error", error: { code: "boom2", message: "resumed call failed" } };
    });
    const doc = app("app_resume_fails", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "needs", tool: writeTool.name }] },
    });
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    const approval = await store.records("vendo_approvals").get("apr_resume_fails");
    await store.records("vendo_approvals").put({
      id: "apr_resume_fails",
      data: { ...(approval?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide("apr_resume_fails", true);
    await flush();

    expect(await engine.runs.get(runId!, ctx())).toMatchObject({
      status: "error",
      error: { code: "boom2", message: "resumed call failed" },
      steps: [{ id: "needs", outcome: "error", detail: "resumed call failed" }],
    });
    expect(await store.records("automations:parked").get("apr_resume_fails")).toBeNull();
  });

  it("discards a resume already in flight when a concurrent stop lands between the app check and the stopped re-read", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const tools = registry([writeTool], async (call, runCtx) => {
      const request = {
        id: "apr_stopped_after_claim",
        call,
        descriptor: writeTool,
        inputPreview: "write",
        ctx: { principal: runCtx.principal, venue: runCtx.venue, presence: runCtx.presence, appId: runCtx.appId, trigger: runCtx.trigger },
        createdAt: NOW.toISOString(),
      };
      await store.records("vendo_approvals").put({ id: request.id, data: { request, status: "pending" } });
      return { status: "pending-approval", approvalId: request.id };
    });
    const doc = app("app_stopped_after_claim", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "needs", tool: writeTool.name }] },
    });
    // resumeRun reads the app AFTER it has already claimed the run (moved it
    // to "running"), so pausing only THAT first `vendo_apps` read — and letting
    // every later one through immediately — lets a concurrent runs.stop() land
    // in between, proving finishStoppedIfNeeded's fresh store re-read (not just
    // the in-memory `stopped` set) catches the race.
    let onAppRecordStart: () => void = () => undefined;
    const didReachAppRecord = new Promise<void>((resolve) => { onAppRecordStart = resolve; });
    let releaseAppRecord!: () => void;
    const appRecordGate = new Promise<void>((resolve) => { releaseAppRecord = resolve; });
    let appsGetCount = 0;
    const gatedStore: StoreAdapter = {
      ensureSchema: () => store.ensureSchema(),
      blobs: (namespace) => store.blobs(namespace),
      records(name: string): RecordStore {
        const inner = store.records(name);
        if (name !== "vendo_apps") return inner;
        return {
          ...inner,
          async get(id) {
            const index = appsGetCount;
            appsGetCount += 1;
            if (index === 0) {
              onAppRecordStart();
              await appRecordGate;
            }
            return await inner.get(id);
          },
        };
      },
    };
    await seedApp(gatedStore, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools, guard, store: gatedStore, now: () => NOW });
    const [runId] = await engine.emit("go", {}, ctx().principal);
    const approval = await store.records("vendo_approvals").get("apr_stopped_after_claim");
    await store.records("vendo_approvals").put({
      id: "apr_stopped_after_claim",
      data: { ...(approval?.data as object), status: "approved", decidedAt: NOW.toISOString() },
    });

    guard.decide("apr_stopped_after_claim", true);
    await didReachAppRecord;
    await engine.runs.stop(runId!, ctx());
    releaseAppRecord();
    await flush();

    expect((await store.records("vendo_runs").get(runId!))?.data).toMatchObject({
      status: "stopped",
      record: { summary: "stopped by user" },
    });
    expect(await store.records("automations:parked").get("apr_stopped_after_claim")).toBeNull();
  });
});

describe("list, tick cursor initialization, and dryRun preview edges", () => {
  it("lists only the caller's triggered apps, excluding other subjects and trigger-less apps", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const triggered = app("app_listed", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    });
    await seedApp(store, triggered, "user_a", true);
    await store.records("vendo_apps").put({
      id: "app_no_trigger",
      data: { subject: "user_a", enabled: false, doc: { format: VENDO_APP_FORMAT, id: "app_no_trigger", name: "no trigger" } },
      refs: { subject: "user_a" },
    });
    await seedApp(store, app("app_other_subject", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [{ id: "a", tool: readTool.name }] },
    }), "user_b", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool]), guard, store, now: () => NOW });

    const listed = await engine.list(ctx());

    expect(listed).toEqual([{ app: triggered, enabled: true }]);
  });

  it("initializes a missing schedule cursor on first tick without firing the same instant it was armed", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_fresh_cursor", {
      on: { kind: "schedule", every: "1h" },
      run: { kind: "steps", steps: [{ id: "a", tool: "fn:main" }] },
    });
    // Enabled directly (bypassing engine.enable()) so no schedule cursor row exists yet.
    await seedApp(store, doc, "user_a", true);
    const engine = createAutomations({ apps: appsDouble(), tools: registry(), guard, store, now: () => NOW });

    const fired = await engine.tick();

    expect(fired).toEqual([]);
    expect((await store.records("automations:schedule").get(doc.id))?.data).toEqual({ lastFiredAt: NOW.toISOString() });
  });

  it("previews the agentic descriptor surface and every static step when no event is supplied", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const agenticDoc = app("app_dryrun_agentic", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "agentic", prompt: "do work" },
    });
    const stepsDoc = app("app_dryrun_no_event", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "a", tool: readTool.name },
        { id: "b", tool: writeTool.name },
      ] },
    });
    await seedApp(store, agenticDoc);
    await seedApp(store, stepsDoc);
    const engine = createAutomations({ apps: appsDouble(), tools: registry([readTool, writeTool]), guard, store, now: () => NOW });

    const agenticPlan = await engine.dryRun(agenticDoc.id, ctx());
    expect(agenticPlan.steps.map((step) => step.id).sort()).toEqual([readTool.name, writeTool.name].sort());

    const noEventPlan = await engine.dryRun(stepsDoc.id, ctx());
    expect(noEventPlan.steps).toEqual([
      { id: "a", tool: readTool.name, wouldAsk: true },
      { id: "b", tool: writeTool.name, wouldAsk: true },
    ]);
  });

  it("degrades to a static step entry when a live jsonata preview expression throws", async () => {
    const store = memoryStoreAdapter();
    const guard = new GuardDouble();
    const doc = app("app_dryrun_throws", {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: [
        { id: "boom", tool: writeTool.name, if: "$notarealfunction(1)" },
      ] },
    });
    await seedApp(store, doc);
    const engine = createAutomations({ apps: appsDouble(), tools: registry([writeTool]), guard, store, now: () => NOW });

    const plan = await engine.dryRun(doc.id, ctx(), { anything: true });

    expect(plan.steps).toEqual([{ id: "boom", tool: writeTool.name, wouldAsk: true }]);
  });
});
