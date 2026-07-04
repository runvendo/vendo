/**
 * Runner tests: fire() end-to-end against the real interpreter and in-memory
 * store, with stub tools. Covers dedup, guard-skip, firing caps, failure
 * streaks (frozen "paused" + disabledReason), per-automation serialization,
 * and pause/resume. Everything is Principal-scoped per the contracts freeze.
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@flowlet/core";
import type { ApprovalPolicy } from "../policy";
import { InMemoryAuditLog } from "../embedded/in-memory-store";
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

// ENG-193 §4.6 — parking fixtures: a for_each over `trigger.rows`, one tool
// step per iteration, optionally guarded.
function forEachSpec(opts: { stepIf?: string } = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [
        {
          id: "loop",
          type: "for_each",
          items: "{{ trigger.rows }}",
          maxItems: 5,
          steps: [
            {
              id: "notify",
              type: "tool",
              tool: "notify_act",
              input: { row: "{{ item }}" },
              ...(opts.stepIf !== undefined ? { if: opts.stepIf } : {}),
            },
          ],
        },
      ],
    },
  });
}

function forEachThenGatedSpec(): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [
        {
          id: "loop",
          type: "for_each",
          items: "{{ trigger.rows }}",
          maxItems: 5,
          steps: [{ id: "notify", type: "tool", tool: "notify_act", input: { row: "{{ item }}" } }],
        },
        { id: "freeze", type: "tool", tool: "freeze_card", input: { cardId: "c1" } },
      ],
    },
  });
}

function forEachEnvelope(eventId: string, rows: unknown[]): TriggerEnvelope {
  return {
    source: "host",
    eventId,
    subject: "user-1",
    occurredAt: NOW,
    payload: { rows },
  };
}

async function setup(opts: {
  spec?: AutomationSpec;
  tools: Record<string, RegisteredTool>;
  policy?: ApprovalPolicy;
}) {
  const store = new InMemoryAutomationStore({ now: () => NOW });
  const { automation } = await store.create(scope, { spec: opts.spec ?? spec(), grants: [] });
  const runner = new AutomationRunner({
    store,
    tools: async () => opts.tools,
    policy: opts.policy ?? allowAll,
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
  });
  return { store, automation, runner };
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

describe("ENG-193 §4.6 — parked-action persistence + resolveParkedAction", () => {
  it("persists every parked draft from a succeeded run and stamps parkedCount", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });

    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a", "b"]));
    expect(run?.status).toBe("succeeded");
    expect(run?.parkedCount).toBe(2);
    expect(notify.calls).toHaveLength(0);

    const rows = await store.listParkedActions(scope, { runId: run!.id });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.automationId).toBe(automation.id);
      expect(row.runId).toBe(run!.id);
      expect(row.resolution).toBeUndefined();
    }
  });

  it("persists parked drafts even when the run ALSO pauses at a later direct-step checkpoint", async () => {
    const notify = makeTool("notify_act");
    const freeze = makeTool("freeze_card");
    const { store, automation, runner } = await setup({
      spec: forEachThenGatedSpec(),
      tools: { notify_act: notify, freeze_card: freeze },
      policy: approveFor("notify_act", "freeze_card"),
    });

    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    expect(run?.outcome).toBe("waiting_approval");
    expect(run?.parkedCount).toBe(1);
    expect(freeze.calls).toHaveLength(0);

    const rows = await store.listParkedActions(scope, { runId: run!.id });
    expect(rows).toHaveLength(1);
  });

  it("resolveParkedAction: 'declined' resolves without executing anything", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "declined");
    expect(result).toEqual({ ok: true, executed: false });
    expect(notify.calls).toHaveLength(0);

    const resolved = await store.getParkedAction(scope, action!.id);
    expect(resolved?.resolution).toBe("declined");
  });

  it("resolveParkedAction: 'approved' executes the tool with the frozen input and a fresh idempotency key", async () => {
    const calls: Array<{ input: Record<string, unknown>; idempotencyKey: string }> = [];
    const notify: RegisteredTool = {
      descriptor: { name: "notify_act", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
      execute: async (input, ctx) => {
        calls.push({ input, idempotencyKey: ctx.idempotencyKey });
        return { ok: true, result: { sent: true } };
      },
    };
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toEqual({ ok: true, executed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ row: "a" });
    expect(calls[0]!.idempotencyKey).toBe(`${run!.id}/notify/parked-${action!.id}`);
  });

  it("resolveParkedAction: a DECLINED policy (tenant/role deny) refuses to execute even on 'approved' — deny always wins", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: forEachSpec(), grants: [] });
    // Approve at park time so the step parks; deny at resolve time so the
    // late execution is refused regardless of the human's "approved" decision.
    let resolving = false;
    const policy: ApprovalPolicy = {
      evaluate: (ctx) => {
        if (ctx.toolName !== "notify_act") return "allow";
        return resolving ? "deny" : "approve";
      },
    };
    const runner = new AutomationRunner({
      store,
      tools: async () => ({ notify_act: notify }),
      policy,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    resolving = true;
    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result.ok).toBe(false);
    expect(notify.calls).toHaveLength(0);

    const stillParked = await store.getParkedAction(scope, action!.id);
    expect(stillParked?.resolution).toBeUndefined();
  });

  it("resolveParkedAction: exactly-once — two concurrent 'approved' calls on the same action execute the tool only once", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const [a, b] = await Promise.all([
      runner.resolveParkedAction(scope, action!.id, "approved"),
      runner.resolveParkedAction(scope, action!.id, "approved"),
    ]);
    expect(notify.calls).toHaveLength(1);
    const oks = [a, b].filter((r) => r.ok);
    const errs = [a, b].filter((r): r is { ok: false; error: string } => !r.ok);
    expect(oks).toHaveLength(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]!.error).toMatch(/already resolved/);
  });

  it("resolveParkedAction: descriptor drift refuses to execute and leaves the action UNRESOLVED", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: forEachSpec(), grants: [] });
    let drifted = false;
    const runner = new AutomationRunner({
      store,
      tools: async () => ({
        notify_act: drifted
          ? {
              ...notify,
              descriptor: {
                ...notify.descriptor,
                annotations: { ...notify.descriptor.annotations, destructiveHint: true },
              },
            }
          : notify,
      }),
      policy: approveFor("notify_act"),
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    drifted = true;
    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result.ok).toBe(false);
    expect(notify.calls).toHaveLength(0);

    const stillParked = await store.getParkedAction(scope, action!.id);
    expect(stillParked?.resolution).toBeUndefined();
  });

  it("resolveParkedAction: guard re-check — a guard referencing only trigger/run/user/loop bindings that now evaluates false skips execution but still resolves 'approved'", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, {
      spec: forEachSpec({ stepIf: "user.sendOk = true" }),
      grants: [],
    });
    // Fresh at park time (guard true, step parks); stale/false by the time
    // resolveParkedAction re-checks it (deviation #2's "trivially possible").
    let claimCalls = 0;
    const userClaims = async () => {
      claimCalls += 1;
      return { sendOk: claimCalls === 1 };
    };
    const runner = new AutomationRunner({
      store,
      tools: async () => ({ notify_act: notify }),
      policy: approveFor("notify_act"),
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      userClaims,
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toMatchObject({ ok: true, executed: false, skipped: true });
    expect((result as { reason?: string }).reason).toMatch(/guard/i);
    expect(notify.calls).toHaveLength(0);

    const resolved = await store.getParkedAction(scope, action!.id);
    expect(resolved?.resolution).toBe("approved");
  });

  it("resolveParkedAction: a guard referencing steps.* is NEVER re-checked — guardStale: true, frozen input executes as-is", async () => {
    const notify = makeTool("notify_act");
    const fetchRows: RegisteredTool = {
      descriptor: { name: "fetch_rows", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
      execute: async () => ({ ok: true, result: { count: 5 } }),
    };
    const spec = automationSpecSchema.parse({
      dslVersion: 1,
      name: "Test",
      description: "test",
      prompt: "test",
      trigger: { type: "host_event", event: "transaction.created" },
      execution: {
        mode: "steps",
        steps: [
          { id: "fetch", type: "tool", tool: "fetch_rows" },
          {
            id: "loop",
            type: "for_each",
            items: "{{ trigger.rows }}",
            maxItems: 5,
            steps: [
              {
                id: "notify",
                type: "tool",
                tool: "notify_act",
                input: { row: "{{ item }}" },
                if: "steps.fetch.output.count > 0",
              },
            ],
          },
        ],
      },
    });
    const { store, automation, runner } = await setup({
      spec,
      tools: { fetch_rows: fetchRows, notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });
    expect(action!.guardExpr).toBe("steps.fetch.output.count > 0");

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(notify.calls).toHaveLength(1);
    expect(notify.calls[0]).toEqual({ row: "a" });
    expect(result).toMatchObject({ ok: true, executed: true, guardStale: true });
  });
});

describe("ENG-193 §6.2 — audit trail for parked-action resolutions", () => {
  it("resolveParkedAction appends a 'consent' audit event on both approve and decline", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: forEachSpec(), grants: [] });
    const audit = new InMemoryAuditLog();
    const runner = new AutomationRunner({
      store,
      tools: async () => ({ notify_act: notify }),
      policy: approveFor("notify_act"),
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });

    const run1 = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [approved] = await store.listParkedActions(scope, { runId: run1!.id });
    await runner.resolveParkedAction(scope, approved!.id, "approved");

    const run2 = await runner.fire(scope, automation.id, forEachEnvelope("e2", ["a"]));
    const [declined] = await store.listParkedActions(scope, { runId: run2!.id });
    await runner.resolveParkedAction(scope, declined!.id, "declined");

    const events = await audit.query(scope, { kinds: ["consent"] });
    expect(events).toHaveLength(2);
    const byDecision = Object.fromEntries(events.map((e) => [e.decision, e]));
    expect(byDecision["yes"]?.consentId).toBe(approved!.id);
    expect(byDecision["no"]?.consentId).toBe(declined!.id);
  });
});
