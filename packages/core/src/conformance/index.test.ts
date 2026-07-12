import { describe, expect, it } from "vitest";
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
