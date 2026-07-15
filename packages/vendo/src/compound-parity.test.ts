import { createActions, type CapabilitiesFile, type ExtractedTool } from "@vendoai/actions";
import { createAutomations } from "@vendoai/automations";
import {
  VENDO_APP_FORMAT,
  VENDO_CAPABILITIES_FORMAT,
  type AppDocument,
  type ApprovalId,
  type AuditEvent,
  type Guard,
  type Json,
  type Principal,
  type RunContext,
  type Step,
  type ToolCall,
  type ToolOutcome,
} from "@vendoai/core";
import { memoryStoreAdapter } from "@vendoai/core/conformance";
import type { AppsRuntime } from "@vendoai/apps";
import { describe, expect, it } from "vitest";

// ENG-249 decision 6: compound step semantics MUST match the automations
// engine's `continueSteps` — automations is the reference implementation.
// One fixture table of step programs runs through BOTH implementations;
// the invoke sequences (tool, args), output propagation (visible through
// later-step args), and halt/park behavior must be identical. The only
// sanctioned divergence is the root binding name: automations binds the
// trigger payload as `event`, compounds bind the call arguments as `args`
// (decision 7) — fixtures write `$ROOT` and each side substitutes its name.

const principal: Principal = { kind: "user", subject: "user_parity" };
const presentCtx: RunContext = {
  principal,
  venue: "chat",
  presence: "present",
  sessionId: "session_parity",
};

type Respond = (call: ToolCall, invocationIndex: number) => ToolOutcome;

interface Fixture {
  name: string;
  /** Step expressions written against `$ROOT`; substituted per side. */
  steps: Step[];
  /** The trigger payload (automations) == the compound call args. Object-shaped for both. */
  root: Record<string, Json>;
  /** Scripted outcomes, shared by both sides; index is the global invoke ordinal. */
  respond: Respond;
  /** For park fixtures: outcomes after the approval is granted. */
  respondAfterResume?: Respond;
  expected: "ok" | "halt" | "park-resume";
}

const ok = (output: Json): ToolOutcome => ({ status: "ok", output });

const fixtures: Fixture[] = [
  {
    name: "sequential outputs propagate through steps.<id>",
    steps: [
      { id: "load", tool: "tool_a", args: { q: "$ROOT.q" } },
      { id: "use", tool: "tool_b", args: { prev: "steps.load.value", again: "$ROOT.q" } },
    ],
    root: { q: "hello" },
    respond: (call) => (call.tool === "tool_a" ? ok({ value: 41 }) : ok("done")),
    expected: "ok",
  },
  {
    name: "if predicate skips a step entirely",
    steps: [
      { id: "gate", tool: "tool_a", if: "$ROOT.go" },
      { id: "always", tool: "tool_b" },
    ],
    root: { go: false },
    respond: () => ok("ran"),
    expected: "ok",
  },
  {
    name: "forEach iterates with item bound",
    steps: [
      { id: "each", tool: "tool_a", forEach: "$ROOT.items", args: { n: "item.n" } },
      { id: "after", tool: "tool_b", args: { all: "steps.each" } },
    ],
    root: { items: [{ n: 1 }, { n: 2 }, { n: 3 }] },
    respond: (call) => ok((call.args as { n?: number }).n ?? "after"),
    expected: "ok",
  },
  {
    name: "forEach over a non-array halts with a validation error",
    steps: [{ id: "each", tool: "tool_a", forEach: "$ROOT.notArray" }],
    root: { notArray: 12 },
    respond: () => ok(null),
    expected: "halt",
  },
  {
    name: "forEach beyond the 1000-item cap halts",
    steps: [{ id: "each", tool: "tool_a", forEach: "$ROOT.items" }],
    root: { items: Array.from({ length: 1001 }, (_, index) => index) },
    respond: () => ok(null),
    expected: "halt",
  },
  {
    name: "a mid-walk error outcome halts before later steps",
    steps: [
      { id: "first", tool: "tool_a" },
      { id: "boom", tool: "tool_b" },
      { id: "never", tool: "tool_c" },
    ],
    root: {},
    respond: (call) => (call.tool === "tool_b"
      ? { status: "error", error: { code: "http-error", message: "500" } }
      : ok(null)),
    expected: "halt",
  },
  {
    name: "a mid-walk park resumes to completion without re-running finished steps",
    steps: [
      { id: "first", tool: "tool_a" },
      { id: "asks", tool: "tool_b", args: { from: "steps.first.value" } },
      { id: "last", tool: "tool_c" },
    ],
    root: {},
    respond: (call) => (call.tool === "tool_b"
      ? { status: "pending-approval", approvalId: "apr_parity_1" }
      : ok({ value: 7 })),
    respondAfterResume: () => ok({ value: 8 }),
    expected: "park-resume",
  },
];

const substituteRoot = (steps: Step[], rootName: string): Step[] =>
  steps.map((step) => ({
    ...step,
    ...(step.if === undefined ? {} : { if: step.if.replaceAll("$ROOT", rootName) }),
    ...(step.forEach === undefined ? {} : { forEach: step.forEach.replaceAll("$ROOT", rootName) }),
    ...(step.args === undefined ? {} : {
      args: Object.fromEntries(Object.entries(step.args).map(([key, expression]) => [key, expression.replaceAll("$ROOT", rootName)])),
    }),
  }));

const fixtureTools: ExtractedTool[] = ["tool_a", "tool_b", "tool_c"].map((name) => ({
  name,
  description: name,
  inputSchema: { type: "object" },
  risk: "read",
  binding: { kind: "route", method: "GET", path: `/${name}`, argsIn: "query" },
}));

const fixtureDescriptor = (name: string): { name: string; description: string; inputSchema: Record<string, unknown>; risk: "read" } =>
  ({ name, description: name, inputSchema: { type: "object" }, risk: "read" });

interface Trace {
  invokes: Array<{ tool: string; args: Json; id: string }>;
}

/** Run a fixture through the compound executor (root binding `args`). */
async function runCompound(fixture: Fixture): Promise<{ trace: Trace; outcomes: ToolOutcome[] }> {
  const trace: Trace = { invokes: [] };
  let resumed = false;
  const capabilities: CapabilitiesFile = {
    format: VENDO_CAPABILITIES_FORMAT,
    tools: [{
      name: "compound_fixture",
      description: "fixture",
      inputSchema: { type: "object" },
      risk: "read",
      binding: { kind: "compound", steps: substituteRoot(fixture.steps, "args") },
    }],
  };
  const actions = createActions({
    tools: fixtureTools,
    capabilities,
    invokeTool: async (call) => {
      const index = trace.invokes.length;
      trace.invokes.push({ tool: call.tool, args: call.args, id: call.id });
      const respond = resumed && fixture.respondAfterResume !== undefined ? fixture.respondAfterResume : fixture.respond;
      return respond(call, index);
    },
  });
  const call: ToolCall = { id: "call_parity_1", tool: "compound_fixture", args: fixture.root };
  const outcomes: ToolOutcome[] = [await actions.execute(call, presentCtx)];
  if (fixture.expected === "park-resume") {
    resumed = true;
    outcomes.push(await actions.execute(call, presentCtx));
  }
  return { trace, outcomes };
}

class GuardDouble implements Guard {
  readonly events: AuditEvent[] = [];
  private readonly callbacks = new Set<(id: ApprovalId, approved: boolean) => void>();

  async check(): Promise<{ action: "run"; decidedBy: "default" }> {
    return { action: "run", decidedBy: "default" };
  }

  async report(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async directions(): Promise<string[]> { return []; }

  onApprovalDecision(callback: (id: ApprovalId, approved: boolean) => void): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  decide(id: ApprovalId, approved: boolean): void {
    for (const callback of this.callbacks) callback(id, approved);
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

/** Run a fixture through the REAL automations engine (root binding `event`). */
async function runAutomations(fixture: Fixture): Promise<{ trace: Trace; finalStatus: string }> {
  const trace: Trace = { invokes: [] };
  const store = memoryStoreAdapter();
  const guard = new GuardDouble();
  let resumed = false;

  const doc: AppDocument = {
    format: VENDO_APP_FORMAT,
    id: "app_parity",
    name: "parity",
    trigger: {
      on: { kind: "host-event", event: "go" },
      run: { kind: "steps", steps: substituteRoot(fixture.steps, "event") },
    },
  };
  await store.records("vendo_apps").put({
    id: doc.id,
    data: { subject: principal.subject, enabled: true, doc },
    refs: { subject: principal.subject, trigger_kind: "host-event" },
  });

  const engine = createAutomations({
    apps: { call: async () => ({ status: "ok", output: {} }) } as AppsRuntime,
    guard,
    store,
    tools: {
      descriptors: async () => fixtureTools.map(({ name }) => fixtureDescriptor(name)),
      execute: async (call) => {
        const index = trace.invokes.length;
        trace.invokes.push({ tool: call.tool, args: call.args, id: call.id });
        const respond = resumed && fixture.respondAfterResume !== undefined ? fixture.respondAfterResume : fixture.respond;
        const outcome = respond(call, index);
        if (outcome.status === "pending-approval") {
          // The guard binding would park the approval record; the double does it here.
          await store.records("vendo_approvals").put({
            id: outcome.approvalId,
            data: {
              request: {
                id: outcome.approvalId,
                call,
                descriptor: fixtureDescriptor(call.tool),
                inputPreview: JSON.stringify(call.args),
                ctx: { principal, venue: "automation", presence: "away" },
                createdAt: new Date().toISOString(),
              },
              status: "pending",
            },
            refs: { subject: principal.subject },
          });
        }
        return outcome;
      },
    },
  });

  const runIds = await engine.emit("go", fixture.root, principal);
  expect(runIds).toHaveLength(1);
  const runCtx: RunContext = { ...presentCtx, venue: "automation" };

  if (fixture.expected === "park-resume") {
    const parked = await engine.runs.get(runIds[0]!, runCtx);
    expect(parked?.status).toBe("pending-approval");
    resumed = true;
    guard.decide("apr_parity_1" as ApprovalId, true);
    await flush();
  }

  const run = await engine.runs.get(runIds[0]!, runCtx);
  return { trace, finalStatus: run?.status ?? "missing" };
}

describe("compound walker parity with the automations engine", () => {
  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const compoundResult = await runCompound(fixture);
      const automationsResult = await runAutomations(fixture);

      // The theorem: both implementations issue the IDENTICAL call sequence.
      expect(compoundResult.trace.invokes.map(({ tool, args }) => ({ tool, args })))
        .toEqual(automationsResult.trace.invokes.map(({ tool, args }) => ({ tool, args })));

      if (fixture.expected === "ok") {
        expect(compoundResult.outcomes[0]!.status).toBe("ok");
        expect(automationsResult.finalStatus).toBe("ok");
      }
      if (fixture.expected === "halt") {
        expect(compoundResult.outcomes[0]!.status).toBe("error");
        expect(automationsResult.finalStatus).toBe("error");
      }
      if (fixture.expected === "park-resume") {
        expect(compoundResult.outcomes[0]).toEqual({ status: "pending-approval", approvalId: "apr_parity_1" });
        expect(compoundResult.outcomes[1]!.status).toBe("ok");
        expect(automationsResult.finalStatus).toBe("ok");
        // Verbatim re-issue on BOTH sides: the parked call reappears with its original id and args.
        const compoundIds = compoundResult.trace.invokes.map(({ id }) => id);
        const automationIds = automationsResult.trace.invokes.map(({ id }) => id);
        const parkedIndex = fixture.steps.findIndex((step) => step.id === "asks");
        expect(compoundIds[parkedIndex + 1]).toBe(compoundIds[parkedIndex]);
        expect(automationIds[parkedIndex + 1]).toBe(automationIds[parkedIndex]);
      }
    });
  }
});
