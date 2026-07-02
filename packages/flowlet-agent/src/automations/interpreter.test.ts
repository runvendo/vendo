/**
 * Interpreter tests: pure step-graph execution against stub tools, a stub
 * agent runner, and the real policy interface. No I/O, no timers.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ApprovalPolicy } from "../policy";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import { computeGrant } from "./grants";
import { interpret, type RegisteredTool } from "./interpreter";
import type { AutomationGrant, TriggerEnvelope } from "./store";

const NOW = "2026-07-01T08:00:00.000Z";

const envelope: TriggerEnvelope = {
  source: "test",
  eventId: "evt-1",
  subject: "user-1",
  occurredAt: NOW,
  payload: { merchant: "DoorDash", amountDollars: 87.4, hour: 1, rows: ["a", "b", "c"] },
};

const allowAll: ApprovalPolicy = { evaluate: () => "allow" };
const approveFor = (...names: string[]): ApprovalPolicy => ({
  evaluate: (ctx) => (names.includes(ctx.toolName) ? "approve" : "allow"),
});
const denyFor = (...names: string[]): ApprovalPolicy => ({
  evaluate: (ctx) => (names.includes(ctx.toolName) ? "deny" : "allow"),
});

interface StubTool extends RegisteredTool {
  calls: Array<Record<string, unknown>>;
}

function makeTool(
  name: string,
  opts: {
    readOnly?: boolean;
    idempotent?: boolean;
    result?: unknown;
    failTimes?: number;
    inputSchema?: RegisteredTool["inputSchema"];
  } = {},
): StubTool {
  let failuresLeft = opts.failTimes ?? 0;
  const tool: StubTool = {
    calls: [],
    descriptor: {
      name,
      source: "caller",
      annotations: {
        readOnlyHint: opts.readOnly ?? false,
        idempotentHint: opts.idempotent ?? false,
      },
      hasExecute: true,
      kind: "function",
    },
    inputSchema: opts.inputSchema,
    execute: async (input) => {
      tool.calls.push(input);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("transient failure");
      }
      return opts.result ?? { ok: true };
    },
  };
  return tool;
}

function specOf(execution: unknown, extra: Record<string, unknown> = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution,
    ...extra,
  });
}

function baseInput(spec: AutomationSpec, tools: Record<string, RegisteredTool>) {
  return {
    spec,
    runId: "run-1",
    envelope,
    user: { id: "user-1", name: "Yousef" },
    tools,
    policy: allowAll,
    principal: { userId: "user-1" },
    now: () => NOW,
  };
}

describe("sequential execution and scope", () => {
  it("runs steps in order and exposes steps.<id>.output to later expressions", async () => {
    const fetch = makeTool("fetch_rows", { result: { data: ["first", "second"] } });
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "fetch", type: "tool", tool: "fetch_rows" },
        {
          id: "send",
          type: "tool",
          tool: "send_msg",
          input: { text: "got {{ steps.fetch.output.data[0] }}", all: "{{ steps.fetch.output.data }}" },
        },
      ],
    });

    const outcome = await interpret(baseInput(spec, { fetch_rows: fetch, send_msg: send }));
    expect(outcome.status).toBe("succeeded");
    expect(send.calls[0]).toEqual({ text: "got first", all: ["first", "second"] });
    expect(outcome.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
  });

  it("skips a step whose `if` is false and records it as skipped", async () => {
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "send", type: "tool", tool: "send_msg", if: "trigger.amountDollars > 500" },
      ],
    });
    const outcome = await interpret(baseInput(spec, { send_msg: send }));
    expect(outcome.status).toBe("succeeded");
    expect(send.calls).toHaveLength(0);
    expect(outcome.steps[0]!.status).toBe("skipped");
  });
});

describe("branch and for_each", () => {
  it("takes the matching branch arm and keeps its children addressable", async () => {
    const small = makeTool("small_path", { result: { note: "small" } });
    const big = makeTool("big_path");
    const after = makeTool("after_tool");
    const spec = specOf({
      mode: "steps",
      steps: [
        {
          id: "size_check",
          type: "branch",
          if: "trigger.amountDollars > 500",
          then: [{ id: "big", type: "tool", tool: "big_path" }],
          else: [{ id: "small", type: "tool", tool: "small_path" }],
        },
        { id: "after", type: "tool", tool: "after_tool", input: { note: "{{ steps.small.output.note }}" } },
      ],
    });
    const outcome = await interpret(
      baseInput(spec, { small_path: small, big_path: big, after_tool: after }),
    );
    expect(outcome.status).toBe("succeeded");
    expect(big.calls).toHaveLength(0);
    expect(after.calls[0]).toEqual({ note: "small" });
  });

  it("iterates for_each with item/index bindings, caps items, and shapes iterations output", async () => {
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [
        {
          id: "loop",
          type: "for_each",
          items: "{{ trigger.rows }}",
          maxItems: 2,
          steps: [
            { id: "notify", type: "tool", tool: "send_msg", input: { row: "{{ item }}", i: "{{ index }}" } },
          ],
        },
      ],
    });
    const outcome = await interpret(baseInput(spec, { send_msg: send }));
    expect(outcome.status).toBe("succeeded");
    expect(send.calls).toEqual([
      { row: "a", i: 0 },
      { row: "b", i: 1 },
    ]);
    const loop = outcome.steps.find((s) => s.id === "loop")!;
    const output = loop.output as { iterations: unknown[]; truncated: boolean };
    expect(output.iterations).toHaveLength(2);
    expect(output.truncated).toBe(true);
  });
});

describe("input validation and error handling", () => {
  it("fails a step whose evaluated input does not match the tool schema", async () => {
    const send = makeTool("send_msg", {
      inputSchema: z.object({ count: z.number() }),
    });
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "send", type: "tool", tool: "send_msg", input: { count: "{{ trigger.merchant }}" } },
      ],
    });
    const outcome = await interpret(baseInput(spec, { send_msg: send }));
    expect(outcome.status).toBe("failed");
    expect(send.calls).toHaveLength(0);
    expect(outcome.steps[0]!.error).toMatch(/count/);
  });

  it("onError continue records the failure and proceeds", async () => {
    const flaky = makeTool("flaky", { failTimes: 99 });
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "flaky", type: "tool", tool: "flaky", onError: { strategy: "continue" } },
        { id: "send", type: "tool", tool: "send_msg" },
      ],
    });
    const outcome = await interpret(baseInput(spec, { flaky, send_msg: send }));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.steps[0]!.status).toBe("failed");
    expect(send.calls).toHaveLength(1);
  });

  it("retries idempotent tools with fresh idempotency keys, then succeeds", async () => {
    const flaky = makeTool("flaky", { idempotent: true, failTimes: 2 });
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "flaky", type: "tool", tool: "flaky", onError: { strategy: "retry", attempts: 3 } },
      ],
    });
    const outcome = await interpret(baseInput(spec, { flaky }));
    expect(outcome.status).toBe("succeeded");
    expect(flaky.calls).toHaveLength(3);
    expect(outcome.steps[0]!.attempts).toBe(3);
    expect(outcome.steps[0]!.idempotencyKey).toBe("run-1/flaky/3");
  });

  it("rejects a retry config on a non-idempotent tool before executing it", async () => {
    // Creation-time validation prevents this config; the interpreter's
    // fail-fast is the backstop (e.g. a manifest republish dropped the hint).
    const send = makeTool("send_msg", { failTimes: 1 });
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "send", type: "tool", tool: "send_msg", onError: { strategy: "retry", attempts: 3 } },
      ],
    });
    const outcome = await interpret(baseInput(spec, { send_msg: send }));
    expect(outcome.status).toBe("failed");
    expect(send.calls).toHaveLength(0);
    expect(outcome.steps[0]!.error).toMatch(/idempotent/);
  });
});

describe("approvals, grants, pause/resume", () => {
  const freezeSpec = () =>
    specOf({
      mode: "steps",
      steps: [
        { id: "first", type: "tool", tool: "fetch_rows" },
        { id: "freeze", type: "tool", tool: "freeze_card", input: { cardId: "c1" } },
        { id: "notify", type: "tool", tool: "send_msg" },
      ],
    });

  it("pauses at an approve-gated step with no grant, carrying a checkpoint", async () => {
    const fetch = makeTool("fetch_rows");
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const outcome = await interpret({
      ...baseInput(freezeSpec(), { fetch_rows: fetch, freeze_card: freeze, send_msg: send }),
      policy: approveFor("freeze_card"),
    });
    expect(outcome.status).toBe("waiting_approval");
    expect(freeze.calls).toHaveLength(0);
    if (outcome.status !== "waiting_approval") throw new Error("unreachable");
    expect(outcome.pendingApproval.stepId).toBe("freeze");
    expect(outcome.pendingApproval.tool).toBe("freeze_card");
    expect(outcome.pendingApproval.checkpoint).toBeTruthy();
  });

  it("executes unattended with a valid scope-hashed grant, pauses on a stale one", async () => {
    const spec = freezeSpec();
    const freeze = makeTool("freeze_card");
    const step = (spec.execution as { steps: Array<{ id: string }> }).steps[1]!;
    const valid: AutomationGrant = computeGrant({
      tool: "freeze_card",
      descriptor: freeze.descriptor,
      spec,
      step: step as never,
      now: NOW,
    });

    const okOutcome = await interpret({
      ...baseInput(spec, {
        fetch_rows: makeTool("fetch_rows"),
        freeze_card: freeze,
        send_msg: makeTool("send_msg"),
      }),
      policy: approveFor("freeze_card"),
      grants: [valid],
    });
    expect(okOutcome.status).toBe("succeeded");
    expect(freeze.calls).toHaveLength(1);

    const stale: AutomationGrant = { ...valid, scopeHash: "drifted" };
    const staleOutcome = await interpret({
      ...baseInput(spec, {
        fetch_rows: makeTool("fetch_rows"),
        freeze_card: makeTool("freeze_card"),
        send_msg: makeTool("send_msg"),
      }),
      policy: approveFor("freeze_card"),
      grants: [stale],
    });
    expect(staleOutcome.status).toBe("waiting_approval");
  });

  it("resume(approved) continues from the paused step without re-running earlier steps", async () => {
    const fetch = makeTool("fetch_rows");
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const tools = { fetch_rows: fetch, freeze_card: freeze, send_msg: send };
    const spec = freezeSpec();

    const paused = await interpret({ ...baseInput(spec, tools), policy: approveFor("freeze_card") });
    if (paused.status !== "waiting_approval") throw new Error("expected pause");

    const resumed = await interpret({
      ...baseInput(spec, tools),
      policy: approveFor("freeze_card"),
      resume: { checkpoint: paused.pendingApproval.checkpoint, approved: true },
    });
    expect(resumed.status).toBe("succeeded");
    expect(fetch.calls).toHaveLength(1); // only from the first pass
    expect(freeze.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
    expect(resumed.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("resume(declined) fails the run at the paused step", async () => {
    const tools = {
      fetch_rows: makeTool("fetch_rows"),
      freeze_card: makeTool("freeze_card"),
      send_msg: makeTool("send_msg"),
    };
    const spec = freezeSpec();
    const paused = await interpret({ ...baseInput(spec, tools), policy: approveFor("freeze_card") });
    if (paused.status !== "waiting_approval") throw new Error("expected pause");

    const resumed = await interpret({
      ...baseInput(spec, tools),
      policy: approveFor("freeze_card"),
      resume: { checkpoint: paused.pendingApproval.checkpoint, approved: false },
    });
    expect(resumed.status).toBe("failed");
    expect(tools.freeze_card.calls).toHaveLength(0);
  });

  it("denied tools fail the step outright", async () => {
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [{ id: "send", type: "tool", tool: "send_msg" }],
    });
    const outcome = await interpret({
      ...baseInput(spec, { send_msg: send }),
      policy: denyFor("send_msg"),
    });
    expect(outcome.status).toBe("failed");
    expect(send.calls).toHaveLength(0);
  });
});

describe("dry-run", () => {
  it("simulates mutating tools (recording evaluated input) and executes read-only ones", async () => {
    const read = makeTool("read_rows", { readOnly: true, result: { data: [1] } });
    const send = makeTool("send_msg");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "read", type: "tool", tool: "read_rows" },
        { id: "send", type: "tool", tool: "send_msg", input: { n: "{{ steps.read.output.data[0] }}" } },
      ],
    });
    const outcome = await interpret({
      ...baseInput(spec, { read_rows: read, send_msg: send }),
      dryRun: true,
    });
    expect(outcome.status).toBe("succeeded");
    expect(read.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(0);
    const simulated = outcome.steps[1]!;
    expect(simulated.status).toBe("simulated");
    expect(simulated.output).toEqual({ simulatedInput: { n: 1 } });
  });
});

describe("agent steps and agentic mode", () => {
  it("hands the agent step its resolved input and allowlisted tools, validating output shape", async () => {
    const requests: unknown[] = [];
    const spec = specOf({
      mode: "steps",
      steps: [
        {
          id: "digest",
          type: "agent",
          goal: "Summarize",
          input: { rows: "{{ trigger.rows }}" },
          tools: ["send_msg"],
          output: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
        },
      ],
    });
    const outcome = await interpret({
      ...baseInput(spec, { send_msg: makeTool("send_msg"), other: makeTool("other") }),
      agentRunner: async (req) => {
        requests.push(req);
        return { subject: "hi" };
      },
    });
    expect(outcome.status).toBe("succeeded");
    const req = requests[0] as { goal: string; input: unknown; tools: Record<string, unknown> };
    expect(req.goal).toBe("Summarize");
    expect(req.input).toEqual({ rows: ["a", "b", "c"] });
    expect(Object.keys(req.tools)).toEqual(["send_msg"]);
  });

  it("policy-gates tools inside an agent step: approve without a grant rejects the call", async () => {
    const freeze = makeTool("freeze_card");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "act", type: "agent", goal: "Handle it", tools: ["freeze_card"] },
      ],
    });
    let callError: string | undefined;
    const outcome = await interpret({
      ...baseInput(spec, { freeze_card: freeze }),
      policy: approveFor("freeze_card"),
      agentRunner: async (req) => {
        try {
          await req.tools["freeze_card"]!.execute({ cardId: "c1" }, { idempotencyKey: "k" });
        } catch (err) {
          callError = err instanceof Error ? err.message : String(err);
        }
        return { done: true };
      },
    });
    expect(outcome.status).toBe("succeeded"); // the agent handled the rejection
    expect(freeze.calls).toHaveLength(0);
    expect(callError).toMatch(/approval|grant/i);
  });

  it("fails an agent step whose output misses a required field", async () => {
    const spec = specOf({
      mode: "steps",
      steps: [
        {
          id: "digest",
          type: "agent",
          goal: "Summarize",
          tools: [],
          output: { type: "object", properties: { subject: { type: "string" } }, required: ["subject"] },
        },
      ],
    });
    const outcome = await interpret({
      ...baseInput(spec, {}),
      agentRunner: async () => ({ wrong: true }),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.steps[0]!.error).toMatch(/subject/);
  });

  it("runs fully agentic mode through the agent runner", async () => {
    const spec = specOf({ mode: "agent", goal: "Handle the email", tools: ["send_msg"], maxToolCalls: 5 });
    const outcome = await interpret({
      ...baseInput(spec, { send_msg: makeTool("send_msg") }),
      agentRunner: async () => ({ done: true }),
    });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.steps).toHaveLength(1);
    expect(outcome.steps[0]!.id).toBe("agent");
  });
});

describe("run guards", () => {
  it("fails the run when the wall clock exceeds the limit", async () => {
    let tick = 0;
    const slow = makeTool("slow_tool");
    const spec = specOf({
      mode: "steps",
      steps: [
        { id: "one", type: "tool", tool: "slow_tool" },
        { id: "two", type: "tool", tool: "slow_tool" },
      ],
    });
    const outcome = await interpret({
      ...baseInput(spec, { slow_tool: slow }),
      maxDurationMs: 100,
      nowMs: () => (tick += 90),
    });
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/wall-clock/);
    expect(slow.calls).toHaveLength(1);
  });
});
