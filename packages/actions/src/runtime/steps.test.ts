import jsonata from "jsonata";
import { describe, expect, it } from "vitest";
import type { Json, Step, ToolCall, ToolOutcome } from "@vendoai/core";
import { STEP_FOREACH_MAX_ITEMS, walkSteps, type StepResumePoint, type StepWalkOptions } from "./steps.js";

const evaluate = async (expression: string, context: Record<string, Json | undefined>): Promise<Json> =>
  await jsonata(expression).evaluate(context) as Json;

interface Harness {
  calls: ToolCall[];
  options: StepWalkOptions;
}

function harness(
  steps: Step[],
  respond: (call: ToolCall) => ToolOutcome,
  root: Record<string, Json> = { args: {} },
  resumeFrom?: StepResumePoint,
): Harness {
  let counter = 0;
  const calls: ToolCall[] = [];
  return {
    calls,
    options: {
      steps,
      root,
      evaluate,
      invoke: async (call) => {
        calls.push(call);
        return respond(call);
      },
      newCallId: () => `call_${++counter}`,
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
    },
  };
}

const ok = (output: Json): ToolOutcome => ({ status: "ok", output });

describe("walkSteps — sequential semantics", () => {
  it("executes steps in order and records outputs under steps.<id>", async () => {
    const { calls, options } = harness(
      [
        { id: "first", tool: "host_a", args: { q: "args.q" } },
        { id: "second", tool: "host_b", args: { prev: "steps.first.value" } },
      ],
      (call) => ok(call.tool === "host_a" ? { value: 41 } : { value: 42 }),
      { args: { q: "hello" } },
    );
    const result = await walkSteps(options);
    expect(result).toEqual({ status: "ok", stepOutputs: { first: { value: 41 }, second: { value: 42 } } });
    expect(calls.map((call) => call.tool)).toEqual(["host_a", "host_b"]);
    expect(calls[0]!.args).toEqual({ q: "hello" });
    expect(calls[1]!.args).toEqual({ prev: 41 });
  });

  it("skips a step whose if predicate is falsy — no invoke, no output entry", async () => {
    const { calls, options } = harness(
      [
        { id: "gate", tool: "host_a", if: "args.go" },
        { id: "after", tool: "host_b" },
      ],
      () => ok("ran"),
      { args: { go: false } },
    );
    const result = await walkSteps(options);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.stepOutputs).toEqual({ after: "ran" });
    expect(calls.map((call) => call.tool)).toEqual(["host_b"]);
  });

  it("halts with a validation error when evaluate throws", async () => {
    const { options } = harness([{ id: "bad", tool: "host_a", if: "args.x" }], () => ok(null));
    options.evaluate = async () => { throw new Error("boom"); };
    const result = await walkSteps(options);
    expect(result.status).toBe("halted");
    if (result.status === "halted") {
      expect(result.outcome).toEqual({ status: "error", error: { code: "validation", message: "boom" } });
      expect(result.step.id).toBe("bad");
    }
  });

  it("halts on an error outcome, surfacing the outcome and the step", async () => {
    const { calls, options } = harness(
      [{ id: "a", tool: "host_a" }, { id: "b", tool: "host_b" }],
      (call) => call.tool === "host_a"
        ? ({ status: "error", error: { code: "http-error", message: "500" } })
        : ok(null),
    );
    const result = await walkSteps(options);
    expect(result).toMatchObject({ status: "halted", outcome: { status: "error" }, step: { id: "a" } });
    expect(calls).toHaveLength(1);
  });

  it("halts on a blocked outcome", async () => {
    const { options } = harness([{ id: "a", tool: "host_a" }], () => ({ status: "blocked", reason: "policy" }));
    const result = await walkSteps(options);
    expect(result).toMatchObject({ status: "halted", outcome: { status: "blocked", reason: "policy" } });
  });
});

describe("walkSteps — forEach semantics", () => {
  it("iterates items, evaluates args against item, and collects outputs as an array", async () => {
    const { calls, options } = harness(
      [
        { id: "load", tool: "host_list" },
        { id: "each", tool: "host_send", forEach: "steps.load.items", args: { to: "item.email" } },
      ],
      (call) => call.tool === "host_list"
        ? ok({ items: [{ email: "a@x" }, { email: "b@x" }] })
        : ok(`sent:${(call.args as { to: string }).to}`),
    );
    const result = await walkSteps(options);
    expect(result.status).toBe("ok");
    expect(result.status === "ok" && result.stepOutputs.each).toEqual(["sent:a@x", "sent:b@x"]);
    expect(calls.map((call) => call.args)).toEqual([{}, { to: "a@x" }, { to: "b@x" }]);
  });

  it("halts with automations' exact message when forEach is not an array", async () => {
    const { options } = harness(
      [{ id: "each", tool: "host_send", forEach: "args.notAnArray" }],
      () => ok(null),
      { args: { notAnArray: 7 } },
    );
    const result = await walkSteps(options);
    expect(result).toMatchObject({
      status: "halted",
      outcome: { status: "error", error: { code: "validation", message: "step each forEach did not produce an array" } },
    });
  });

  it(`halts when forEach exceeds ${STEP_FOREACH_MAX_ITEMS} items, matching automations' message`, async () => {
    const { calls, options } = harness(
      [{ id: "each", tool: "host_send", forEach: "args.items" }],
      () => ok(null),
      { args: { items: Array.from({ length: STEP_FOREACH_MAX_ITEMS + 1 }, (_, index) => index) } },
    );
    const result = await walkSteps(options);
    expect(result).toMatchObject({
      status: "halted",
      outcome: { status: "error", error: { code: "validation", message: "step each forEach exceeds 1000 items" } },
    });
    expect(calls).toHaveLength(0);
  });
});

describe("walkSteps — park and resume", () => {
  const steps: Step[] = [
    { id: "read", tool: "host_read" },
    { id: "write", tool: "host_write", args: { from: "steps.read.value" } },
    { id: "after", tool: "host_after" },
  ];

  it("parks with a resume point carrying the exact pending call", async () => {
    const { calls, options } = harness(steps, (call) => call.tool === "host_write"
      ? ({ status: "pending-approval", approvalId: "apr_1" })
      : ok({ value: 9 }));
    const result = await walkSteps(options);
    expect(result.status).toBe("parked");
    if (result.status === "parked") {
      expect(result.approvalId).toBe("apr_1");
      expect(result.resume.stepIndex).toBe(1);
      expect(result.resume.stepOutputs).toEqual({ read: { value: 9 } });
      expect(result.resume.pendingCall).toEqual(calls[1]);
      expect(result.resume.forEachIndex).toBeUndefined();
    }
  });

  it("resume re-issues the pending call VERBATIM, skips completed steps, then continues", async () => {
    const parked = await walkSteps(harness(steps, (call) => call.tool === "host_write"
      ? ({ status: "pending-approval", approvalId: "apr_1" })
      : ok({ value: 9 })).options);
    if (parked.status !== "parked") throw new Error("expected parked");

    const resumed = harness(steps, () => ok("resumed"), { args: {} }, parked.resume);
    const result = await walkSteps(resumed.options);
    expect(result.status).toBe("ok");
    // The first call after resume is the parked call, identical id + args; host_read never re-runs.
    expect(resumed.calls[0]).toEqual(parked.resume.pendingCall);
    expect(resumed.calls.map((call) => call.tool)).toEqual(["host_write", "host_after"]);
    expect(result.status === "ok" && result.stepOutputs).toEqual({
      read: { value: 9 },
      write: "resumed",
      after: "resumed",
    });
  });

  it("a re-issued call that parks again keeps the same resume point with the new approvalId", async () => {
    const parked = await walkSteps(harness(steps, (call) => call.tool === "host_write"
      ? ({ status: "pending-approval", approvalId: "apr_1" })
      : ok({ value: 9 })).options);
    if (parked.status !== "parked") throw new Error("expected parked");

    const again = await walkSteps(harness(steps, () => ({ status: "pending-approval", approvalId: "apr_2" }), { args: {} }, parked.resume).options);
    expect(again).toMatchObject({ status: "parked", approvalId: "apr_2" });
    if (again.status === "parked") expect(again.resume.pendingCall).toEqual(parked.resume.pendingCall);
  });

  it("a re-issued call that errors halts at the parked step", async () => {
    const parked = await walkSteps(harness(steps, (call) => call.tool === "host_write"
      ? ({ status: "pending-approval", approvalId: "apr_1" })
      : ok({ value: 9 })).options);
    if (parked.status !== "parked") throw new Error("expected parked");

    const result = await walkSteps(harness(steps, () => ({ status: "blocked", reason: "declined" }), { args: {} }, parked.resume).options);
    expect(result).toMatchObject({ status: "halted", outcome: { status: "blocked" }, step: { id: "write" } });
  });

  it("parks mid-forEach and resumes at the next iteration", async () => {
    const forEachSteps: Step[] = [
      { id: "each", tool: "host_send", forEach: "args.items", args: { n: "item" } },
      { id: "done", tool: "host_done" },
    ];
    const root = { args: { items: [1, 2, 3] } };
    const first = harness(forEachSteps, (call) => (call.args as { n?: number }).n === 2
      ? ({ status: "pending-approval", approvalId: "apr_1" })
      : ok((call.args as { n?: number }).n ?? "done"), root);
    const parked = await walkSteps(first.options);
    expect(parked.status).toBe("parked");
    if (parked.status !== "parked") throw new Error("expected parked");
    expect(parked.resume.forEachIndex).toBe(1);
    expect(parked.resume.iterationItems).toEqual([1, 2, 3]);
    expect(parked.resume.iterationOutputs).toEqual([1]);

    const second = harness(forEachSteps, (call) => ok((call.args as { n?: number }).n ?? "done"), root, parked.resume);
    const result = await walkSteps(second.options);
    expect(result.status).toBe("ok");
    // Verbatim re-issue of item 2, then item 3, then the next step; item 1 not re-run.
    expect(second.calls[0]).toEqual(parked.resume.pendingCall);
    expect(second.calls.map((call) => call.args)).toEqual([{ n: 2 }, { n: 3 }, {}]);
    expect(result.status === "ok" && result.stepOutputs).toEqual({ each: [1, 2, 3], done: "done" });
  });
});
