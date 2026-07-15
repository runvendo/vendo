import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActions, type CapabilitiesFile, type CompoundTool, type ExtractedTool } from "@vendoai/actions";
import {
  VENDO_CAPABILITIES_FORMAT,
  VENDO_TOOLS_FORMAT,
  descriptorHash,
  type ActAs,
  type AuditEvent,
  type PermissionGrant,
  type Principal,
  type RunContext,
  type Step,
  type ToolCall,
  type ToolRegistry,
} from "@vendoai/core";
import { createGuard, type PolicyConfig } from "@vendoai/guard";
import { createStore } from "@vendoai/store";
import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVendo } from "./server.js";

// 04-actions §6 guard-visibility e2e: compound steps route through the REAL
// guard binding, so approvals, grants, breakers, and audit demonstrably see
// every individual step. The stub-seam adversarial suite lives in
// packages/actions/src/security/compound-no-bypass.test.ts.

const principal: Principal = { kind: "user", subject: "user_compound" };
const ctx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_compound",
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function routeTool(name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "route", method: "GET", path: `/${name}`, argsIn: "query" },
    ...extras,
  };
}

const writeTool = (name: string, extras: Partial<ExtractedTool> = {}): ExtractedTool =>
  routeTool(name, { risk: "write", binding: { kind: "route", method: "POST", path: `/${name}`, argsIn: "body" }, ...extras });

function compound(name: string, steps: Step[], extras: Partial<CompoundTool> = {}): CompoundTool {
  return {
    name,
    description: `compound ${name}`,
    inputSchema: { type: "object" },
    risk: "read",
    binding: { kind: "compound", steps },
    ...extras,
  };
}

const capabilities = (tools: CompoundTool[]): CapabilitiesFile => ({ format: VENDO_CAPABILITIES_FORMAT, tools });

function countingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
}

/** The umbrella wiring replicated exactly (server.ts): createActions, guard.bind, then invokeTool → the binding. */
async function compose(options: {
  tools: ExtractedTool[];
  capabilities: CapabilitiesFile;
  policy?: PolicyConfig;
  breakers?: { maxCallsPerMinute?: number; maxWritesPerRun?: number };
  actAs?: ActAs;
}): Promise<{
  guard: ReturnType<typeof createGuard>;
  bound: ToolRegistry;
  fetchSpy: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof createStore>;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "vendo-compound-"));
  const store = createStore({ dataDir });
  cleanups.push(async () => { await store.close(); await rm(dataDir, { recursive: true, force: true }); });
  await store.ensureSchema();
  const guard = createGuard({
    store,
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.breakers === undefined ? {} : { breakers: options.breakers }),
  });
  const fetchSpy = countingFetch();
  const actionsConfig: {
    tools: ExtractedTool[];
    capabilities: CapabilitiesFile;
    baseUrl: string;
    fetch: typeof fetch;
    actAs?: ActAs;
    invokeTool?: ToolRegistry["execute"];
  } = {
    tools: options.tools,
    capabilities: options.capabilities,
    baseUrl: "https://host.test",
    fetch: fetchSpy as unknown as typeof fetch,
    ...(options.actAs === undefined ? {} : { actAs: options.actAs }),
  };
  const actions = createActions(actionsConfig);
  const bound = guard.bind(actions);
  actionsConfig.invokeTool = (call, callCtx) => bound.execute(call, callCtx);
  return { guard, bound, fetchSpy, store };
}

const call = (tool: string, args: Record<string, unknown> = {}, id = "call_c1"): ToolCall => ({ id, tool, args });

async function auditEvents(guard: { audit: { query(filter: { principal?: Principal; limit?: number }): Promise<{ events: AuditEvent[] }> } }): Promise<AuditEvent[]> {
  return (await guard.audit.query({ principal, limit: 100 })).events;
}

describe("per-step approvals through the real guard", () => {
  const tools = [routeTool("host_list"), writeTool("host_send")];
  const flow = capabilities([
    compound("host_flow", [
      { id: "list", tool: "host_list" },
      { id: "send", tool: "host_send", args: { total: "steps.list.ok" } },
    ], { risk: "write" }),
  ]);

  it("a write step parks the compound with the STEP's approval; approving resumes without re-running the read step", async () => {
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: flow,
      policy: { rules: [{ match: { tool: "host_send" }, action: "ask" }] },
    });

    const parked = await bound.execute(call("host_flow"), ctx);
    expect(parked.status).toBe("pending-approval");
    // Only the read step did real work before the park.
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // The pending approval is the STEP call, not the compound.
    const pending = await guard.approvals.pending(principal);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.call.tool).toBe("host_send");
    expect(pending[0]!.descriptor.name).toBe("host_send");
    expect(parked.status === "pending-approval" && parked.approvalId).toBe(pending[0]!.id);

    // The read step was audited as its own guarded tool-call.
    const eventsBefore = await auditEvents(guard);
    expect(eventsBefore.some((event) => event.kind === "tool-call" && event.tool === "host_list" && event.outcome === "ok")).toBe(true);

    await guard.approvals.decide(pending[0]!.id, { approve: true }, principal);

    // Re-execute the SAME logical call: completed steps are not re-run; the
    // parked step call is re-issued verbatim, matching the single-use approval.
    const resumed = await bound.execute(call("host_flow"), ctx);
    expect(resumed.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const events = await auditEvents(guard);
    const sendCalls = events.filter((event) => event.kind === "tool-call" && event.tool === "host_send");
    expect(sendCalls.some((event) => event.outcome === "ok" && event.decidedBy === "grant")).toBe(true);
    // Every step outcome is individually audited with its decision provenance.
    for (const stepTool of ["host_list", "host_send"]) {
      expect(events.some((event) => event.kind === "tool-call" && event.tool === stepTool && event.decidedBy !== undefined)).toBe(true);
    }
  });

  it("a standing grant on the step tool lets the whole compound run, audited per step as grant-decided", async () => {
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: flow,
      policy: { rules: [{ match: { tool: "host_send" }, action: "ask" }] },
    });

    // Mint the grant through the real approval flow (remember = standing).
    await bound.execute(call("host_flow", {}, "call_mint"), ctx);
    const pending = await guard.approvals.pending(principal);
    await guard.approvals.decide(pending[0]!.id, {
      approve: true,
      remember: { scope: { kind: "tool" }, duration: "standing" },
    }, principal);
    await bound.execute(call("host_flow", {}, "call_mint"), ctx);
    fetchSpy.mockClear();

    // A NEW logical call now runs end to end without asking.
    const outcome = await bound.execute(call("host_flow", {}, "call_granted"), ctx);
    expect(outcome.status).toBe("ok");
    expect(await guard.approvals.pending(principal)).toHaveLength(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const events = await auditEvents(guard);
    const granted = events.find((event) =>
      event.kind === "tool-call" && event.tool === "host_send" && event.outcome === "ok"
        && event.decidedBy === "grant" && (event.detail as { grantId?: string } | undefined)?.grantId !== undefined);
    expect(granted).toBeDefined();
  });

  it("approving or granting the COMPOUND name only does NOT exempt its steps", async () => {
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: flow,
      policy: {
        rules: [
          { match: { tool: "host_flow" }, action: "ask" },
          { match: { tool: "host_send" }, action: "ask" },
        ],
      },
    });

    // The compound itself asks first; approve it WITH a standing grant on the compound name.
    const parkedAtCompound = await bound.execute(call("host_flow"), ctx);
    expect(parkedAtCompound.status).toBe("pending-approval");
    expect(fetchSpy).not.toHaveBeenCalled();
    const compoundApproval = (await guard.approvals.pending(principal))[0]!;
    expect(compoundApproval.call.tool).toBe("host_flow");
    await guard.approvals.decide(compoundApproval.id, {
      approve: true,
      remember: { scope: { kind: "tool" }, duration: "standing" },
    }, principal);

    // Re-execute: the compound runs, but the write STEP still asks individually.
    const parkedAtStep = await bound.execute(call("host_flow"), ctx);
    expect(parkedAtStep.status).toBe("pending-approval");
    const stepApproval = (await guard.approvals.pending(principal))[0]!;
    expect(stepApproval.call.tool).toBe("host_send");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // only the read step ran
  });
});

describe("breakers and critical steps see individual step calls", () => {
  it("maxWritesPerRun trips on the second write STEP inside one compound call", async () => {
    const tools = [writeTool("host_send"), writeTool("host_send2")];
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: capabilities([
        compound("host_flow", [
          { id: "one", tool: "host_send" },
          { id: "two", tool: "host_send2" },
        ], { risk: "write" }),
      ]),
      // Budget of 2: the compound's own write decision consumes 1, the first
      // write step consumes 2, the second write step trips the breaker.
      breakers: { maxWritesPerRun: 2 },
    });

    const outcome = await bound.execute(call("host_flow"), ctx);
    expect(outcome.status).toBe("pending-approval");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const pending = await guard.approvals.pending(principal);
    expect(pending[0]!.call.tool).toBe("host_send2");
    const events = await auditEvents(guard);
    expect(events.some((event) => event.kind === "approval" && event.tool === "host_send2" && event.decidedBy === "breaker")).toBe(true);
  });

  it("a critical step asks EVERY run even with a standing grant", async () => {
    const tools = [writeTool("host_critical", { critical: true })];
    const { guard, bound } = await compose({
      tools,
      capabilities: capabilities([
        compound("host_flow", [{ id: "crit", tool: "host_critical" }], { risk: "write" }),
      ]),
    });

    const first = await bound.execute(call("host_flow", {}, "call_run1"), ctx);
    expect(first.status).toBe("pending-approval");
    const approval = (await guard.approvals.pending(principal))[0]!;
    expect(approval.call.tool).toBe("host_critical");
    await guard.approvals.decide(approval.id, {
      approve: true,
      remember: { scope: { kind: "tool" }, duration: "standing" },
    }, principal);
    expect((await bound.execute(call("host_flow", {}, "call_run1"), ctx)).status).toBe("ok");

    // A NEW run still asks: per-step critical semantics survive compounds.
    const second = await bound.execute(call("host_flow", {}, "call_run2"), ctx);
    expect(second.status).toBe("pending-approval");
  });
});

describe("no unguarded path", () => {
  it("every host fetch during a compound walk has a matching guarded step audit event", async () => {
    const tools = [routeTool("host_a"), routeTool("host_b"), writeTool("host_c")];
    const stepNames = new Set(["host_a", "host_b", "host_c"]);
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: capabilities([
        compound("host_flow", [
          { id: "a", tool: "host_a" },
          { id: "b", tool: "host_b" },
          { id: "c", tool: "host_c" },
        ], { risk: "write" }),
      ]),
    });

    const outcome = await bound.execute(call("host_flow"), ctx);
    expect(outcome.status).toBe("ok");

    const events = await auditEvents(guard);
    const auditedStepCalls = events.filter((event) => event.kind === "tool-call" && stepNames.has(event.tool ?? ""));
    // The theorem, asserted mechanically: work count === guarded-call count.
    expect(fetchSpy).toHaveBeenCalledTimes(auditedStepCalls.length);
    expect(auditedStepCalls).toHaveLength(3);
  });

  it("a policy block on a step tool stops the compound with zero fetches for that step", async () => {
    const tools = [routeTool("host_list"), writeTool("host_send")];
    const { guard, bound, fetchSpy } = await compose({
      tools,
      capabilities: capabilities([
        compound("host_flow", [
          { id: "list", tool: "host_list" },
          { id: "send", tool: "host_send" },
        ], { risk: "write" }),
      ]),
      policy: { rules: [{ match: { tool: "host_send" }, action: "block", note: "sends are off" }] },
    });

    const outcome = await bound.execute(call("host_flow"), ctx);
    expect(outcome).toMatchObject({ status: "blocked", reason: "sends are off" });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the read step only

    const events = await auditEvents(guard);
    expect(events.some((event) => event.kind === "tool-call" && event.tool === "host_send" && event.outcome === "blocked")).toBe(true);
  });

  it("away: steps park individually, and actAs only ever sees STEP grants — never the compound's", async () => {
    // Away execution only honors app-bound, automation-minted grants (05 §6),
    // so this test mints them exactly the way the automations engine does.
    const awayCtx: RunContext = {
      principal,
      venue: "automation",
      presence: "away",
      sessionId: "session_compound",
      appId: "app_flow",
      trigger: { runId: "run_away_1", kind: "schedule" },
    };
    const actAsGrants: PermissionGrant[] = [];
    const actAs: ActAs = async (_principal, grant) => {
      actAsGrants.push(grant);
      return { headers: { authorization: "Bearer away-token" } };
    };
    const listTool = routeTool("host_list");
    const compoundFlow = compound("host_flow", [{ id: "list", tool: "host_list" }]);
    const { guard, bound, fetchSpy, store } = await compose({
      tools: [listTool],
      capabilities: capabilities([compoundFlow]),
      actAs,
    });

    const mintAutomationGrant = async (tool: string, descriptor: { name: string; description: string; inputSchema: Record<string, unknown>; risk: "read" | "write" | "destructive" }): Promise<void> => {
      const grant: PermissionGrant = {
        id: `grt_away_${tool}`,
        subject: principal.subject,
        tool,
        descriptorHash: descriptorHash(descriptor),
        scope: { kind: "tool" },
        duration: "standing",
        appId: "app_flow",
        source: "automation",
        grantedAt: new Date().toISOString(),
      };
      await store.records("vendo_grants").put({
        id: grant.id,
        data: grant,
        refs: { subject: grant.subject, tool: grant.tool, app_id: "app_flow" },
      });
    };

    // Grant the COMPOUND only. Its READ step holds no grant, so the 05 §6
    // away downgrade parks the STEP — the compound's authority does not flow down.
    await mintAutomationGrant("host_flow", {
      name: "host_flow",
      description: "compound host_flow",
      inputSchema: { type: "object" },
      risk: "read",
    });
    const parked = await bound.execute(call("host_flow", {}, "call_away"), awayCtx);
    expect(parked.status).toBe("pending-approval");
    expect(fetchSpy).not.toHaveBeenCalled();
    const stepApproval = (await guard.approvals.pending(principal))[0]!;
    expect(stepApproval.call.tool).toBe("host_list");

    // Grant the step too and re-execute: actAs receives the STEP's grant.
    await mintAutomationGrant("host_list", {
      name: "host_list",
      description: "host_list",
      inputSchema: { type: "object" },
      risk: "read",
    });
    const resumed = await bound.execute(call("host_flow", {}, "call_away"), awayCtx);
    expect(resumed.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(actAsGrants.length).toBeGreaterThan(0);
    for (const grant of actAsGrants) {
      expect(grant.tool).toBe("host_list");
      expect(grant.tool).not.toBe("host_flow");
    }
  });
});

describe("the real createVendo composition wires the seam", () => {
  it("a compound defined in .vendo/capabilities.json executes through guard with per-step approvals", async () => {
    const root = await mkdtemp(join(tmpdir(), "vendo-umbrella-compound-"));
    const dataDir = await mkdtemp(join(tmpdir(), "vendo-umbrella-store-"));
    const previousCwd = process.cwd();
    cleanups.push(async () => {
      process.chdir(previousCwd);
      await rm(root, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    });
    await mkdir(join(root, ".vendo"));
    await writeFile(join(root, ".vendo", "tools.json"), JSON.stringify({
      format: VENDO_TOOLS_FORMAT,
      tools: [routeTool("host_list"), writeTool("host_send")],
    }));
    await writeFile(join(root, ".vendo", "capabilities.json"), JSON.stringify(capabilities([
      compound("host_flow", [
        { id: "list", tool: "host_list" },
        { id: "send", tool: "host_send" },
      ], { risk: "write" }),
    ])));

    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const fetchSpy = countingFetch();
    vi.stubGlobal("fetch", fetchSpy);

    process.chdir(root);
    const store = createStore({ dataDir });
    cleanups.push(async () => { await store.close(); });
    // createVendo kicks off ensureSchema() without blocking; approvals need it done.
    await store.ensureSchema();
    const vendo = createVendo({
      model: {} as LanguageModel,
      principal: async () => principal,
      store,
      policy: { rules: [{ match: { tool: "host_send" }, action: "ask" }] },
    });

    expect((await vendo.actions.descriptors()).map((descriptor) => descriptor.name)).toContain("host_flow");

    // Execute through the guard exactly as the agent does (guard.bind is a
    // stateless wrapper over the same guard instance the umbrella wired).
    const bound = vendo.guard.bind(vendo.actions);
    const parked = await bound.execute(call("host_flow"), ctx);
    expect(parked.status).toBe("pending-approval");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const pending = await vendo.guard.approvals.pending(principal);
    expect(pending[0]!.call.tool).toBe("host_send");
    await vendo.guard.approvals.decide(pending[0]!.id, { approve: true }, principal);

    const resumed = await bound.execute(call("host_flow"), ctx);
    expect(resumed.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
