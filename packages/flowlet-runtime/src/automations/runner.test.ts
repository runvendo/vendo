/**
 * Runner tests: fire() end-to-end against the real interpreter and in-memory
 * store, with stub tools. Covers dedup, guard-skip, firing caps, failure
 * streaks (frozen "paused" + disabledReason), per-automation serialization,
 * and pause/resume. Everything is Principal-scoped per the contracts freeze.
 */
import { describe, expect, it } from "vitest";
import type { OutboundMessage, Principal } from "@flowlet/core";
import type { ApprovalPolicy } from "../policy";
import { AutomationRunner } from "./runner";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore, type TriggerEnvelope } from "./store";

const NOW = "2026-07-01T08:00:00.000Z";
const scope: Principal = { tenantId: "tenant-1", subject: "user-1" };
const allowAll: ApprovalPolicy = { evaluate: () => "allow" };
const approveFor = (...names: string[]): ApprovalPolicy => ({
  evaluate: (ctx) => (names.includes(ctx.toolName) ? "approve" : "allow"),
});

function makeTool(
  name: string,
  opts: { failTimes?: number; onCall?: () => Promise<void> | void } = {},
) {
  let failuresLeft = opts.failTimes ?? 0;
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: {
      name,
      source: "caller",
      annotations: {},
      hasExecute: true,
      kind: "function",
    },
    execute: async (input) => {
      calls.push(input);
      await opts.onCall?.();
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        return { ok: false, error: { code: "boom", message: "boom" } };
      }
      return { ok: true, result: { done: true } };
    },
  };
  return tool;
}

function spec(overrides: Record<string, unknown> = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [
        { id: "send", type: "tool", tool: "send_msg", input: { text: "{{ trigger.merchant }}" } },
      ],
    },
    ...overrides,
  });
}

function envelope(eventId: string, occurredAt = NOW): TriggerEnvelope {
  return {
    source: "host",
    eventId,
    subject: "user-1",
    occurredAt,
    payload: { merchant: "DoorDash", amountDollars: 87.4 },
  };
}

async function setup(opts: {
  spec?: AutomationSpec;
  tools: Record<string, RegisteredTool>;
  policy?: ApprovalPolicy;
  deliver?: (message: OutboundMessage) => Promise<void>;
  nowMs?: () => number;
}) {
  const store = new InMemoryAutomationStore({ now: () => NOW });
  const { automation } = await store.create(scope, { spec: opts.spec ?? spec(), grants: [] });
  const delivered: OutboundMessage[] = [];
  const runner = new AutomationRunner({
    store,
    tools: async () => opts.tools,
    policy: opts.policy ?? allowAll,
    now: () => NOW,
    nowMs: opts.nowMs ?? (() => Date.parse(NOW)),
    channels: {
      deliver:
        opts.deliver ??
        (async (m) => {
          delivered.push(m);
        }),
    },
  });
  return { store, automation, runner, delivered };
}

describe("fire", () => {
  it("executes the spec and finalizes the run with interpolated tool input", async () => {
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({ tools: { send_msg: send } });

    const run = await runner.fire(scope, automation.id, envelope("e1"));
    expect(run?.status).toBe("succeeded");
    expect(send.calls[0]).toEqual({ text: "DoorDash" });
    expect((await store.get(scope, automation.id))?.counters.totalRuns).toBe(1);
  });

  it("records a guard-false firing as a compact skipped run (coarse succeeded)", async () => {
    const send = makeTool("send_msg");
    const { runner, automation } = await setup({
      spec: spec({ if: "trigger.amountDollars > 500" }),
      tools: { send_msg: send },
    });
    const run = await runner.fire(scope, automation.id, envelope("e1"));
    expect(run?.status).toBe("succeeded");
    expect(run?.outcome).toBe("skipped");
    expect(run?.steps).toEqual([]);
    expect(send.calls).toHaveLength(0);
  });

  it("drops a duplicate envelope as a no-op", async () => {
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({ tools: { send_msg: send } });
    await runner.fire(scope, automation.id, envelope("e1"));
    const dup = await runner.fire(scope, automation.id, envelope("e1"));
    expect(dup).toBeUndefined();
    expect(await store.listRuns(scope, automation.id)).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
  });

  it("cancels firings beyond maxFiringsPerHour, visibly", async () => {
    const send = makeTool("send_msg");
    const { runner, automation } = await setup({
      spec: spec({ limits: { maxFiringsPerHour: 2 } }),
      tools: { send_msg: send },
    });
    await runner.fire(scope, automation.id, envelope("e1"));
    await runner.fire(scope, automation.id, envelope("e2"));
    const third = await runner.fire(scope, automation.id, envelope("e3"));
    expect(third?.outcome).toBe("cancelled");
    expect(third?.error).toMatch(/maxFiringsPerHour/);
    expect(send.calls).toHaveLength(2);
  });

  it("parks the automation after 5 consecutive failures (paused + disabledReason)", async () => {
    const send = makeTool("send_msg", { failTimes: 99 });
    const { runner, automation, store } = await setup({ tools: { send_msg: send } });
    for (let i = 0; i < 5; i++) {
      const run = await runner.fire(scope, automation.id, envelope(`e${i}`));
      expect(run?.status).toBe("failed");
    }
    const parked = await store.get(scope, automation.id);
    expect(parked?.status).toBe("paused");
    expect(parked?.disabledReason).toBe("consecutive_failures");
    const after = await runner.fire(scope, automation.id, envelope("e-after"));
    expect(after).toBeUndefined();
  });

  it("serializes overlapping firings of one automation", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let first = true;
    const send = makeTool("send_msg", {
      onCall: async () => {
        if (first) {
          first = false;
          order.push("first-start");
          await gate;
          order.push("first-end");
        } else {
          order.push("second-start");
        }
      },
    });
    const { runner, automation } = await setup({ tools: { send_msg: send } });

    const p1 = runner.fire(scope, automation.id, envelope("e1"));
    const p2 = runner.fire(scope, automation.id, envelope("e2"));
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["first-start"]);
    releaseFirst!();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });
});

describe("pause and resume", () => {
  const gatedSpec = () =>
    spec({
      execution: {
        mode: "steps",
        steps: [
          { id: "freeze", type: "tool", tool: "freeze_card", input: { cardId: "c1" } },
          { id: "send", type: "tool", tool: "send_msg" },
        ],
      },
    });

  it("persists waiting_approval with the pending approval, then resumes to completion", async () => {
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: freeze, send_msg: send },
      policy: approveFor("freeze_card"),
    });

    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    expect(paused?.status).toBe("running"); // coarse
    expect(paused?.outcome).toBe("waiting_approval");
    expect(paused?.pendingApproval?.stepId).toBe("freeze");
    expect(freeze.calls).toHaveLength(0);

    const resumed = await runner.resume(scope, paused!.id, true);
    expect(resumed?.status).toBe("succeeded");
    expect(freeze.calls).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
    expect((await store.getRun(scope, paused!.id))?.status).toBe("succeeded");
  });

  it("two concurrent approvals of one pending run execute the gated step exactly once (review P1)", async () => {
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const { runner, automation } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: freeze, send_msg: send },
      policy: approveFor("freeze_card"),
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    expect(paused?.outcome).toBe("waiting_approval");

    const [a, b] = await Promise.all([
      runner.resume(scope, paused!.id, true),
      runner.resume(scope, paused!.id, true),
    ]);
    expect(freeze.calls).toHaveLength(1);
    expect([a, b].filter((r) => r !== undefined)).toHaveLength(1);
  });

  it("fails the run when the approval is declined", async () => {
    const freeze = makeTool("freeze_card");
    const { runner, automation } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: freeze, send_msg: makeTool("send_msg") },
      policy: approveFor("freeze_card"),
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    const resumed = await runner.resume(scope, paused!.id, false);
    expect(resumed?.status).toBe("failed");
    expect(freeze.calls).toHaveLength(0);
  });
});

describe("channel deliveries (FlowletToasts, 2026-07-04 spec)", () => {
  const gatedSpec = () =>
    spec({
      execution: {
        mode: "steps",
        steps: [
          { id: "freeze", type: "tool", tool: "freeze_card", input: { cardId: "c1" } },
          { id: "send", type: "tool", tool: "send_msg" },
        ],
      },
    });

  it("delivers exactly one completed message for a succeeded run", async () => {
    const { runner, automation, delivered } = await setup({ tools: { send_msg: makeTool("send_msg") } });
    const run = await runner.fire(scope, automation.id, envelope("e1"));
    const completed = delivered.filter((m) => m.automation?.kind === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.channel).toBe("in-app");
    expect(completed[0]!.principal).toEqual(scope);
    expect(completed[0]!.automation?.runId).toBe(run!.id);
    expect(completed[0]!.automation?.summary).toContain("Test");
  });

  it("delivers completed for a failed run, with the error in the summary", async () => {
    const { runner, automation, delivered } = await setup({
      tools: { send_msg: makeTool("send_msg", { failTimes: 99 }) },
    });
    await runner.fire(scope, automation.id, envelope("e1"));
    const completed = delivered.filter((m) => m.automation?.kind === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.automation?.summary).toMatch(/fail/i);
  });

  it("delivers completed for a cap-cancelled run", async () => {
    const send = makeTool("send_msg");
    const { runner, automation, delivered } = await setup({
      spec: spec({ limits: { maxFiringsPerHour: 1 } }),
      tools: { send_msg: send },
    });
    await runner.fire(scope, automation.id, envelope("e1"));
    await runner.fire(scope, automation.id, envelope("e2"));
    const kinds = delivered.map((m) => `${m.automation?.kind}:${m.automation?.summary?.includes("dropped") ? "drop" : "run"}`);
    expect(kinds.filter((k) => k.startsWith("completed"))).toHaveLength(2);
    expect(delivered.some((m) => m.automation?.summary?.includes("dropped"))).toBe(true);
  });

  it("stays silent for guard-false skipped runs (spec: skips are routine)", async () => {
    const { runner, automation, delivered } = await setup({
      spec: spec({ if: "trigger.amountDollars > 500" }),
      tools: { send_msg: makeTool("send_msg") },
    });
    await runner.fire(scope, automation.id, envelope("e1"));
    expect(delivered).toHaveLength(0);
  });

  it("delivers approval-required when pausing, then completed after an approved resume; a second resume delivers nothing more", async () => {
    const { runner, automation, delivered } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: makeTool("freeze_card"), send_msg: makeTool("send_msg") },
      policy: approveFor("freeze_card"),
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    const approvals = delivered.filter((m) => m.automation?.kind === "approval-required");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.automation?.runId).toBe(paused!.id);
    expect(approvals[0]!.automation?.stepId).toBe("freeze");

    await runner.resume(scope, paused!.id, true);
    expect(delivered.filter((m) => m.automation?.kind === "completed")).toHaveLength(1);

    const countAfterResume = delivered.length;
    expect(await runner.resume(scope, paused!.id, true)).toBeUndefined();
    expect(delivered).toHaveLength(countAfterResume);
  });

  it("resume with a mismatched expectedStepId is stale: nothing executes, nothing delivers", async () => {
    const freeze = makeTool("freeze_card");
    const { runner, automation, delivered } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: freeze, send_msg: makeTool("send_msg") },
      policy: approveFor("freeze_card"),
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    const before = delivered.length;

    // A toast minted for some other pause must not approve THIS one.
    expect(await runner.resume(scope, paused!.id, true, "some-other-step")).toBeUndefined();
    expect(freeze.calls).toHaveLength(0);
    expect(delivered).toHaveLength(before);

    // The matching stepId still resumes.
    const resumed = await runner.resume(scope, paused!.id, true, "freeze");
    expect(resumed?.status).toBe("succeeded");
    expect(freeze.calls).toHaveLength(1);
  });

  it("delivers completed (cancelled) when a pending approval expires", async () => {
    let clock = Date.parse(NOW);
    const { runner, automation, delivered } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: makeTool("freeze_card"), send_msg: makeTool("send_msg") },
      policy: approveFor("freeze_card"),
      nowMs: () => clock,
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    clock += 1000 * 60 * 60 * 24 * 30; // way past any approval expiry
    const cancelled = await runner.resume(scope, paused!.id, true);
    expect(cancelled?.outcome).toBe("cancelled");
    const completed = delivered.filter((m) => m.automation?.kind === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]!.automation?.summary).toMatch(/expire/i);
  });

  it("a failing delivery never fails the run (best-effort surface)", async () => {
    const { runner, automation } = await setup({
      tools: { send_msg: makeTool("send_msg") },
      deliver: async () => {
        throw new Error("toast surface down");
      },
    });
    const run = await runner.fire(scope, automation.id, envelope("e1"));
    expect(run?.status).toBe("succeeded");
  });
});
