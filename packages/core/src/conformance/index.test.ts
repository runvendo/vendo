import { describe, expect, it } from "vitest";
import { VENDO_APP_FORMAT } from "../index.js";
import {
  actAsConformance,
  agentRunnerConformance,
  guardConformance,
  memoryStoreAdapter,
  runConformance,
  secretsProviderConformance,
  storeAdapterConformance,
  toolRegistryConformance,
} from "./index.js";
import type {
  AgentRunner,
  AuditEvent,
  Guard,
  PermissionGrant,
  Principal,
  RunContext,
  StoreAdapter,
  ToolCall,
  ToolDescriptor,
  ToolRegistry,
} from "../index.js";

const at = "2026-07-11T16:00:00.000Z";
const principal: Principal = { kind: "user", subject: "user_conformance" };
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_conformance",
  appId: "app_conformance",
};

const criticalDescriptor: ToolDescriptor = {
  name: "host_delete_conformance",
  description: "Delete a conformance fixture",
  inputSchema: { type: "object" },
  risk: "destructive",
  critical: true,
};
const criticalCall: ToolCall = {
  id: "call_critical",
  tool: criticalDescriptor.name,
  args: { id: "fixture_1" },
};
const readDescriptor: ToolDescriptor = {
  name: "host_read_conformance",
  description: "Read a conformance fixture",
  inputSchema: { type: "object" },
  risk: "read",
};
const readCall: ToolCall = {
  id: "call_read",
  tool: readDescriptor.name,
  args: { id: "fixture_1" },
};
const sampleAuditEvent: AuditEvent = {
  id: "aud_conformance",
  at,
  kind: "tool-call",
  principal,
  venue: ctx.venue,
  presence: ctx.presence,
  tool: readDescriptor.name,
  outcome: "ok",
};

const minimalGuard = (criticalRuns = false): Guard => ({
  async check(call, descriptor, context) {
    if (descriptor.critical && !criticalRuns) {
      return {
        action: "ask",
        decidedBy: "critical",
        approval: {
          id: "apr_conformance",
          call,
          descriptor,
          inputPreview: JSON.stringify(call.args),
          ctx: {
            principal: context.principal,
            venue: context.venue,
            presence: context.presence,
            ...(context.appId === undefined ? {} : { appId: context.appId }),
            ...(context.trigger === undefined ? {} : { trigger: context.trigger }),
          },
          createdAt: at,
        },
      };
    }
    return { action: "run", decidedBy: "default" };
  },
  async report() {},
  async directions() {
    return [];
  },
  onApprovalDecision() {
    return () => undefined;
  },
});

const guardSuite = (makeGuard: () => Promise<Guard>) => guardConformance({
  makeGuard,
  ctx,
  criticalDescriptor,
  criticalCall,
  readDescriptor,
  readCall,
  sampleAuditEvent,
});

describe("StoreAdapter conformance", () => {
  it("accepts the memoryStoreAdapter reference double", async () => {
    const report = await runConformance(storeAdapterConformance({
      async makeAdapter() {
        return { adapter: memoryStoreAdapter() };
      },
    }));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
    expect(report.passed).toBeGreaterThan(0);
  });

  it("rejects a broken store and reports failing case names", async () => {
    const report = await runConformance(storeAdapterConformance({
      async makeAdapter() {
        const base = memoryStoreAdapter();
        const adapter: StoreAdapter = {
          ...base,
          records(collection) {
            return { ...base.records(collection), async get() { return null; } };
          },
        };
        return { adapter };
      },
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name)).toContain(
      "01-core §12 — records.get round-trips a put record",
    );
    expect(report.failures.every((failure) => failure.name.length > 0)).toBe(true);
  });

  it("memoryStoreAdapter lists newest-first (double-level behavior, not contract)", async () => {
    const records = memoryStoreAdapter().records("ordering");
    for (const id of ["first", "second", "third"]) {
      await records.put({ id, data: { id } });
    }
    const listed = await records.list();
    expect(listed.records.map((record) => record.id)).toEqual(["third", "second", "first"]);
    expect(listed.records.some((record) => "seq" in record)).toBe(false);
  });

  it("memoryStoreAdapter atomic writes enforce absence and revision guards", async () => {
    const records = memoryStoreAdapter().records("atomic");
    const input = {
      id: "atomic_1",
      data: { status: "draft", nested: { count: 1 } },
      refs: { owner: "user_1" },
    };

    const inserted = await records.atomic.insertIfAbsent(input);
    expect(inserted).toMatchObject({
      id: input.id,
      data: input.data,
      refs: input.refs,
      revision: "1",
    });
    expect(await records.atomic.insertIfAbsent({ ...input, data: { status: "duplicate" } })).toBeNull();
    expect(await records.atomic.compareAndSwap({ id: "missing", data: {} }, "1")).toBeNull();
    expect(await records.atomic.compareAndSwap({ ...input, data: { status: "wrong revision" } }, "0")).toBeNull();

    input.data.nested.count = 2;
    input.refs.owner = "mutated";
    expect(await records.get(input.id)).toMatchObject({
      data: { status: "draft", nested: { count: 1 } },
      refs: { owner: "user_1" },
    });

    const swapped = await records.atomic.compareAndSwap({
      id: input.id,
      data: { status: "published" },
      refs: { owner: "user_2" },
    }, "1");
    expect(swapped).toMatchObject({
      id: input.id,
      data: { status: "published" },
      refs: { owner: "user_2" },
      revision: "2",
      createdAt: inserted?.createdAt,
    });
    expect(await records.get(input.id)).toEqual(swapped);
  });
});

describe("ToolRegistry conformance", () => {
  const call: ToolCall = { id: "call_registry", tool: "conformance_read", args: {} };

  it("accepts a minimal registry", async () => {
    const registry: ToolRegistry = {
      async descriptors() {
        return [{
          name: "conformance_read",
          description: "Read a conformance value",
          inputSchema: { type: "object" },
          risk: "read",
        }];
      },
      async execute() {
        return { status: "ok", output: { value: true } };
      },
    };
    const report = await runConformance(toolRegistryConformance({
      async makeRegistry() { return registry; },
      ctx,
      safeCall: call,
    }));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
  });

  it("rejects a registry descriptor with a dot in its name", async () => {
    const report = await runConformance(toolRegistryConformance({
      async makeRegistry() {
        return {
          async descriptors() {
            return [{
              name: "conformance.read",
              description: "Invalid name",
              inputSchema: { type: "object" },
              risk: "read" as const,
            }];
          },
          async execute() {
            return { status: "ok" as const, output: null };
          },
        };
      },
      ctx,
    }));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name)).toContain(
      "01-core §4 — descriptors are valid, uniquely named, and hashable",
    );
  });
});

describe("Guard conformance", () => {
  it("accepts a minimal contract-shaped guard", async () => {
    const report = await runConformance(guardSuite(async () => minimalGuard()));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
  });

  it("rejects a guard that runs critical calls", async () => {
    const report = await runConformance(guardSuite(async () => minimalGuard(true)));
    expect(report.ok).toBe(false);
    expect(report.failures.map((failure) => failure.name)).toContain(
      "01-core §4; 05-guard §2 step 1 — critical always asks with frozen descriptor and input preview",
    );
  });
});

describe("host seam conformance", () => {
  it("accepts a map-backed SecretsProvider", async () => {
    const values = new Map([["PRESENT", "secret-value"]]);
    const report = await runConformance(secretsProviderConformance({
      async makeProvider() {
        return { async get(name) { return values.get(name); } };
      },
      presentName: "PRESENT",
      expectedValue: "secret-value",
      absentName: "ABSENT",
    }));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
  });

  it("accepts an ActAs stub with Authorization headers", async () => {
    const grant: PermissionGrant = {
      id: "grt_conformance",
      subject: principal.subject,
      tool: readDescriptor.name,
      descriptorHash: "sha256:conformance",
      scope: { kind: "tool" },
      duration: "standing",
      source: "chat",
      grantedAt: at,
    };
    const report = await runConformance(actAsConformance({
      async actAs() {
        return { headers: { Authorization: "Bearer x" } };
      },
      principal,
      grant,
    }));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
  });

  it("accepts a scripted AgentRunner that executes the supplied echo registry", async () => {
    const runner: AgentRunner = async (task, runContext) => {
      expect(await task.tools.descriptors()).toEqual([{
        name: "conformance_echo",
        description: "Echo conformance input",
        inputSchema: { type: "object" },
        risk: "read",
      }]);
      const call: ToolCall = { id: "call_echo", tool: "conformance_echo", args: { ping: true } };
      const outcome = await task.tools.execute(call, runContext);
      return {
        status: "ok",
        summary: "Executed the conformance echo call.",
        toolCalls: [{ call, outcome: outcome.status }],
      };
    };
    const report = await runConformance(agentRunnerConformance({
      async makeRunner() { return runner; },
      ctx,
    }));
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, failures: [] });
  });
});

describe("memoryStoreAdapter reserved routing", () => {
  const approval = {
    id: "apr_memory_projection",
    call: readCall,
    descriptor: readDescriptor,
    inputPreview: JSON.stringify(readCall.args),
    ctx: { principal, venue: ctx.venue, presence: ctx.presence, appId: ctx.appId },
    createdAt: at,
  };
  const app = {
    format: VENDO_APP_FORMAT,
    id: "app_memory_projection",
    name: "Memory projection",
    trigger: {
      on: { kind: "host-event" as const, event: "memory.changed" },
      run: { kind: "steps" as const, steps: [] },
    },
  };
  const grant: PermissionGrant = {
    id: "grt_memory_projection",
    subject: principal.subject,
    tool: readDescriptor.name,
    descriptorHash: "sha256:memory",
    scope: { kind: "tool" },
    duration: "standing",
    appId: app.id,
    source: "chat",
    grantedAt: at,
  };

  it("validates every routed reserved collection and derives its public projection", async () => {
    const adapter = memoryStoreAdapter({ timestamp: () => "2026-07-11T16:01:00.000Z" });
    const cases = [
      {
        collection: "vendo_grants",
        id: grant.id,
        data: grant,
        refs: { subject: principal.subject, tool: readDescriptor.name, app_id: app.id },
        createdAt: at,
      },
      {
        collection: "vendo_approvals",
        id: approval.id,
        data: { request: approval, status: "pending", ignored: true },
        refs: { subject: principal.subject, status: "pending" },
        createdAt: at,
      },
      {
        collection: "vendo_audit",
        id: sampleAuditEvent.id,
        data: sampleAuditEvent,
        refs: { subject: principal.subject, kind: sampleAuditEvent.kind, tool: readDescriptor.name },
        createdAt: at,
      },
      {
        collection: "vendo_threads",
        id: "thr_memory_projection",
        data: { subject: principal.subject, messages: [{ role: "user", content: "hello" }], ignored: true },
        refs: { subject: principal.subject },
        createdAt: "2026-07-11T16:01:00.000Z",
      },
      {
        collection: "vendo_runs",
        id: "run_memory_projection",
        data: {
          appId: app.id,
          trigger: { kind: "external", ignored: true },
          status: "running",
          record: { ok: true },
          startedAt: at,
          ignored: true,
        },
        refs: { app_id: app.id, status: "running" },
        createdAt: at,
      },
      {
        collection: "vendo_apps",
        id: app.id,
        data: { subject: principal.subject, enabled: true, doc: app, ignored: true },
        refs: { subject: principal.subject, trigger_kind: "host-event" },
        createdAt: "2026-07-11T16:01:00.000Z",
      },
      {
        collection: "vendo_state",
        id: `${app.id}:${principal.subject}`,
        data: { selected: "one" },
        refs: { app_id: app.id, subject: principal.subject },
        createdAt: "2026-07-11T16:01:00.000Z",
      },
    ];

    for (const testCase of cases) {
      const stored = await adapter.records(testCase.collection).put({
        id: testCase.id,
        data: testCase.data,
        refs: { forged: "caller refs must be ignored" },
      });
      expect(stored.refs, testCase.collection).toEqual(testCase.refs);
      expect(stored.createdAt, testCase.collection).toBe(testCase.createdAt);
      expect((stored.data as Record<string, unknown>)["ignored"], testCase.collection).toBeUndefined();
    }
    expect((await adapter.records("vendo_apps").list({ refs: { trigger_kind: "host-event" } })).records)
      .toHaveLength(1);
  });

  it("rejects invalid shapes at all seven reserved doors", async () => {
    const adapter = memoryStoreAdapter();
    const invalid = [
      ["vendo_grants", "grt_invalid", {}],
      ["vendo_approvals", "apr_invalid", {}],
      ["vendo_audit", "aud_invalid", {}],
      ["vendo_threads", "thr_invalid", {}],
      ["vendo_runs", "run_invalid", {}],
      ["vendo_apps", "app_invalid", {}],
      ["vendo_state", "invalid-state-id", undefined],
    ] as const;
    for (const [collection, id, data] of invalid) {
      await expect(adapter.records(collection).put({ id, data }), collection).rejects.toMatchObject({
        code: "validation",
      });
    }
  });

  it("round-trips optional approval decision fields into the projection", async () => {
    const adapter = memoryStoreAdapter();
    const stored = await adapter.records("vendo_approvals").put({
      id: approval.id,
      data: {
        request: approval,
        status: "approved",
        decidedAt: "2026-07-11T16:02:00.000Z",
        sessionId: "session_conformance",
        consumedAt: "2026-07-11T16:03:00.000Z",
      },
    });
    expect(stored.data).toMatchObject({
      status: "approved",
      decidedAt: "2026-07-11T16:02:00.000Z",
      sessionId: "session_conformance",
      consumedAt: "2026-07-11T16:03:00.000Z",
    });
    expect(stored.refs).toEqual({ subject: principal.subject, status: "approved" });
    expect(stored.updatedAt).toBe("2026-07-11T16:03:00.000Z");
  });

  it("rejects field-level shape violations behind each reserved door", async () => {
    const adapter = memoryStoreAdapter();
    const rejects = (collection: string, id: string, data: unknown) =>
      expect(
        adapter.records(collection).put({ id, data: data as never }),
        `${collection} ${JSON.stringify(data)}`,
      ).rejects.toMatchObject({ code: "validation" });

    await rejects("vendo_approvals", approval.id, ["not an object"]);
    await rejects("vendo_approvals", approval.id, { request: approval, status: "consumed" });
    await rejects("vendo_approvals", approval.id, { request: approval, status: "pending", sessionId: 5 });
    await rejects("vendo_approvals", approval.id, { request: approval, status: "pending", decidedAt: "yesterday" });
    await rejects("vendo_approvals", "apr_other_id", { request: approval, status: "pending" });
    await rejects("vendo_threads", "thr_shape", { subject: 5, messages: [] });
    await rejects("vendo_threads", "thr_shape", { subject: principal.subject, messages: "not an array" });
    await rejects("vendo_runs", "run_shape", {
      appId: app.id, trigger: { kind: "cron" }, status: "running", record: null, startedAt: at,
    });
    await rejects("vendo_runs", "run_shape", {
      appId: app.id, trigger: { kind: "external", event: 5 }, status: "running", record: null, startedAt: at,
    });
    await rejects("vendo_runs", "run_shape", {
      appId: app.id, trigger: { kind: "external" }, status: "done", record: null, startedAt: at,
    });
    await rejects("vendo_apps", app.id, { subject: 5, enabled: true, doc: app });
    await rejects("vendo_apps", app.id, { subject: principal.subject, enabled: "yes", doc: app });
  });

  it("accepts only JSON-serializable thread messages", async () => {
    const threads = memoryStoreAdapter().records("vendo_threads");
    const stored = await threads.put({
      id: "thr_json",
      data: { subject: principal.subject, messages: [[1, "two", null], { nested: { ok: true } }] },
    });
    expect((stored.data as { messages: unknown[] }).messages).toEqual([[1, "two", null], { nested: { ok: true } }]);

    const cyclicObject: Record<string, unknown> = {};
    cyclicObject["self"] = cyclicObject;
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    const invalidMessages: unknown[] = [
      cyclicObject,
      cyclicArray,
      () => {},
      Number.NaN,
      new Date(at),
      [() => {}],
    ];
    for (const message of invalidMessages) {
      await expect(threads.put({
        id: "thr_json",
        data: { subject: principal.subject, messages: [message] } as never,
      })).rejects.toMatchObject({ code: "validation" });
    }
  });

  it("requires well-formed vendo_state ids on put and delete", async () => {
    const state = memoryStoreAdapter().records("vendo_state");
    await expect(state.put({ id: "no-colon", data: {} })).rejects.toMatchObject({ code: "validation" });
    await expect(state.put({ id: "invoice_1:user_one", data: {} })).rejects.toMatchObject({ code: "validation" });
    await expect(state.put({ id: "app_x:", data: {} })).rejects.toMatchObject({ code: "validation" });
    await expect(state.delete("invoice_1:user_one")).rejects.toMatchObject({ code: "validation" });
  });

  it("rejects unknown reserved ref filters and cross-subject thread updates", async () => {
    const adapter = memoryStoreAdapter();
    await expect(adapter.records("vendo_apps").list({ refs: { forged: "x" } })).rejects.toMatchObject({
      code: "validation",
    });
    const threads = adapter.records("vendo_threads");
    await threads.put({ id: "thr_owned", data: { subject: "user_one", messages: [] } });
    await expect(threads.put({
      id: "thr_owned",
      data: { subject: "user_two", messages: [] },
    })).rejects.toMatchObject({ code: "conflict" });
  });

  it("mirrors the routed door's append-only vendo_audit (02-store §2)", async () => {
    const audit = memoryStoreAdapter().records("vendo_audit");
    await audit.put({ id: sampleAuditEvent.id, data: sampleAuditEvent });
    await expect(audit.put({ id: sampleAuditEvent.id, data: sampleAuditEvent }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(audit.delete(sampleAuditEvent.id)).rejects.toMatchObject({ code: "blocked" });
    expect((await audit.get(sampleAuditEvent.id))?.data).toEqual(sampleAuditEvent);
  });

  it("mirrors the routed door's cross-subject flip refusal for apps and grants (02-store §2)", async () => {
    const adapter = memoryStoreAdapter();
    const apps = adapter.records("vendo_apps");
    await apps.put({ id: app.id, data: { subject: "user_one", enabled: true, doc: app } });
    await expect(apps.put({ id: app.id, data: { subject: "user_two", enabled: true, doc: app } }))
      .rejects.toMatchObject({ code: "conflict" });
    const sameSubject = await apps.put({ id: app.id, data: { subject: "user_one", enabled: false, doc: app } });
    expect((sameSubject.data as { enabled: boolean }).enabled).toBe(false);

    const grants = adapter.records("vendo_grants");
    await grants.put({ id: grant.id, data: grant });
    await expect(grants.put({ id: grant.id, data: { ...grant, subject: "user_two" } }))
      .rejects.toMatchObject({ code: "conflict" });
    const revoked = await grants.put({ id: grant.id, data: { ...grant, revokedAt: "2026-07-11T16:05:00.000Z" } });
    expect((revoked.data as { revokedAt?: string }).revokedAt).toBe("2026-07-11T16:05:00.000Z");
  });
});
