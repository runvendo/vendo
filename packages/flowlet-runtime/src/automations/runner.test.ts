/**
 * Runner tests: fire() end-to-end against the real interpreter and in-memory
 * store, with stub tools. Covers dedup, guard-skip, firing caps, failure
 * streaks (frozen "paused" + disabledReason), per-automation serialization,
 * and pause/resume. Everything is Principal-scoped per the contracts freeze.
 */
import { describe, expect, it } from "vitest";
import type { OutboundMessage, Principal } from "@flowlet/core";
import type { ApprovalPolicy } from "../policy";
import { InMemoryAuditLog } from "../embedded/in-memory-store";
import { AutomationRunner } from "./runner";
import { hashDescriptor } from "./grants";
import { automationSpecSchema, type AutomationSpec } from "./schema";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore, MAX_STEP_OUTPUT_BYTES, type TriggerEnvelope } from "./store";

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

  it("resume obtains the approval via the atomic claim, not read-then-clear", async () => {
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({
      spec: gatedSpec(),
      tools: { freeze_card: freeze, send_msg: send },
      policy: approveFor("freeze_card"),
    });
    const paused = await runner.fire(scope, automation.id, envelope("e1"));
    expect(paused?.outcome).toBe("waiting_approval");

    // Spy AFTER the run is parked: count claims, record updateRun patches, and
    // hide pendingApproval from reads so a read-then-clear path cannot work.
    let claimCalls = 0;
    const originalClaim = store.claimPendingApproval.bind(store);
    store.claimPendingApproval = async (s, id) => {
      claimCalls += 1;
      return originalClaim(s, id);
    };
    const updatePatches: Array<Record<string, unknown>> = [];
    const originalUpdateRun = store.updateRun.bind(store);
    store.updateRun = async (s, id, patch) => {
      updatePatches.push(patch);
      return originalUpdateRun(s, id, patch);
    };
    const originalGetRun = store.getRun.bind(store);
    store.getRun = async (s, id) => {
      const run = await originalGetRun(s, id);
      if (!run) return run;
      const { pendingApproval: _hidden, ...rest } = run;
      return rest;
    };

    const resumed = await runner.resume(scope, paused!.id, true);
    expect(resumed?.status).toBe("succeeded");
    expect(freeze.calls).toHaveLength(1);
    expect(claimCalls).toBe(1);
    expect(updatePatches.some((p) => "pendingApproval" in p)).toBe(false);
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

describe("ENG-193 §4.6 — resolveParkedAction fail-closed + ordering (review follow-up)", () => {
  it("a TRUNCATED frozen input refuses to execute and leaves the row unresolved (re-askable)", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    // A park whose input exceeds the storage cap — capParkedInput truncates
    // it and stamps inputTruncated at create (store.test.ts covers the
    // stamping; here we assert the resolve side fails closed on it). Seeded
    // directly: the trigger payload has its OWN 32KB cap, so an oversized
    // loop input can't be driven through fire() from the envelope.
    const action = await store.createParkedAction(scope, {
      automationId: automation.id,
      runId: "run-x",
      stepId: "notify",
      tool: "notify_act",
      input: { row: "x".repeat(MAX_STEP_OUTPUT_BYTES + 500) },
      reason: "ungranted",
      tier: "act",
      descriptorHash: hashDescriptor(notify.descriptor),
      requestedAt: NOW,
    });
    expect(action.inputTruncated).toBe(true);

    const result = await runner.resolveParkedAction(scope, action.id, "approved");
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/truncated/i);
    expect(notify.calls).toHaveLength(0);
    // Still unresolved — re-askable, never silently declined.
    expect((await store.getParkedAction(scope, action.id))?.resolution).toBeUndefined();
  });

  it("a FAILED execute leaves the row unresolved with NO consent event; a retry reuses the same idempotency key and succeeds", async () => {
    const calls: Array<{ input: Record<string, unknown>; idempotencyKey: string }> = [];
    let failuresLeft = 1;
    const notify: RegisteredTool = {
      descriptor: { name: "notify_act", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
      execute: async (input, ctx) => {
        calls.push({ input, idempotencyKey: ctx.idempotencyKey });
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          return { ok: false, error: { code: "boom", message: "gmail down" } };
        }
        return { ok: true, result: { sent: true } };
      },
    };
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
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const failed = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(failed).toEqual({ ok: false, error: "gmail down" });
    // Unresolved (re-askable) and NO consent event claiming a success.
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBeUndefined();
    expect(await audit.query(scope, { kinds: ["consent"] })).toHaveLength(0);

    const retried = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(retried).toMatchObject({ ok: true, executed: true });
    expect(calls).toHaveLength(2);
    // Both attempts carried the SAME key — a key-deduping executor cannot
    // double-fire across the retry.
    expect(calls[0]!.idempotencyKey).toBe(calls[1]!.idempotencyKey);
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBe("approved");
    expect(await audit.query(scope, { kinds: ["consent"] })).toHaveLength(1);
  });

  it("a guard referencing steps via BRACKET access is treated as steps-referencing (guardStale, frozen input executes)", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: forEachSpec(),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    // Seeded directly: the boundary is a property of the STORED guardExpr,
    // however it was authored. If the regex missed the bracket form, the
    // re-check would evaluate against steps:{} -> false -> skipped, and the
    // executed:true assertion below would fail.
    const action = await store.createParkedAction(scope, {
      automationId: automation.id,
      runId: "run-x",
      stepId: "notify",
      tool: "notify_act",
      input: { row: "a" },
      guardExpr: 'steps["fetch"].output.count > 0',
      reason: "ungranted",
      tier: "act",
      descriptorHash: hashDescriptor(notify.descriptor),
      requestedAt: NOW,
    });

    const result = await runner.resolveParkedAction(scope, action.id, "approved");
    expect(result).toMatchObject({ ok: true, executed: true, guardStale: true });
    expect(notify.calls).toEqual([{ row: "a" }]);
  });
});

describe("ENG-193 §6.2 — automation audit completeness (diary prerequisite)", () => {
  it("finalize() appends ONE automation_firing event per completed run (succeeded or failed)", async () => {
    const send = makeTool("send_msg");
    const okStore = new InMemoryAutomationStore({ now: () => NOW });
    const { automation: okAutomation } = await okStore.create(scope, { spec: spec(), grants: [] });
    const audit = new InMemoryAuditLog();
    const okRunner = new AutomationRunner({
      store: okStore,
      tools: async () => ({ send_msg: send }),
      policy: allowAll,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });
    const okRun = await okRunner.fire(scope, okAutomation.id, envelope("e1"));
    expect(okRun?.status).toBe("succeeded");

    const failSend = makeTool("send_msg", { failTimes: 1 });
    const failStore = new InMemoryAutomationStore({ now: () => NOW });
    const { automation: failAutomation } = await failStore.create(scope, { spec: spec(), grants: [] });
    const failRunner = new AutomationRunner({
      store: failStore,
      tools: async () => ({ send_msg: failSend }),
      policy: allowAll,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });
    const failRun = await failRunner.fire(scope, failAutomation.id, envelope("e2"));
    expect(failRun?.status).toBe("failed");

    const events = await audit.query(scope, { kinds: ["automation_firing"] });
    expect(events).toHaveLength(2);
    const byRunId = Object.fromEntries(
      events.map((e) => [(e as { runId: string }).runId, e]),
    );
    expect(byRunId[okRun!.id]).toMatchObject({ automationId: okAutomation.id, runId: okRun!.id });
    expect(byRunId[failRun!.id]).toMatchObject({ automationId: failAutomation.id, runId: failRun!.id });
  });

  it("a skipped (guard=false) or cancelled (rate-capped) firing appends NO automation_firing event", async () => {
    const send = makeTool("send_msg");
    const audit = new InMemoryAuditLog();

    const skipStore = new InMemoryAutomationStore({ now: () => NOW });
    const { automation: skipAutomation } = await skipStore.create(scope, {
      spec: spec({ if: "trigger.amountDollars > 500" }),
      grants: [],
    });
    const skipRunner = new AutomationRunner({
      store: skipStore,
      tools: async () => ({ send_msg: send }),
      policy: allowAll,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });
    const skipRun = await skipRunner.fire(scope, skipAutomation.id, envelope("e1"));
    expect(skipRun?.outcome).toBe("skipped");

    const capStore = new InMemoryAutomationStore({ now: () => NOW });
    const { automation: capAutomation } = await capStore.create(scope, {
      spec: spec({ limits: { maxFiringsPerHour: 1 } }),
      grants: [],
    });
    const capRunner = new AutomationRunner({
      store: capStore,
      tools: async () => ({ send_msg: send }),
      policy: allowAll,
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });
    await capRunner.fire(scope, capAutomation.id, envelope("e2"));
    const cancelledRun = await capRunner.fire(scope, capAutomation.id, envelope("e3"));
    expect(cancelledRun?.outcome).toBe("cancelled");

    // The one successful capped firing DOES get an automation_firing event —
    // only the skipped and cancelled runs must produce none.
    const events = await audit.query(scope, { kinds: ["automation_firing"] });
    const runIds = events.map((e) => (e as { runId: string }).runId);
    expect(runIds).not.toContain(skipRun!.id);
    expect(runIds).not.toContain(cancelledRun!.id);
  });

  it("resolveParkedAction appends a tool_execution event on a successful execute", async () => {
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
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toEqual({ ok: true, executed: true });

    const events = await audit.query(scope, { kinds: ["tool_execution"] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "tool_execution",
      toolName: "notify_act",
      toolCallId: `parked-${action!.id}`,
      mutating: true,
      dangerous: false,
      outcome: "ok",
    });
  });

  it("a critical parked action's resolved tool_execution is flagged dangerous: true", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const criticalNotify: RegisteredTool = {
      descriptor: {
        name: "notify_act",
        source: "caller",
        annotations: { destructiveHint: true },
        hasExecute: true,
        kind: "function",
      },
      execute: async (input) => {
        calls.push(input);
        return { ok: true, result: { done: true } };
      },
    };
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: forEachSpec(), grants: [] });
    const audit = new InMemoryAuditLog();
    const runner = new AutomationRunner({
      store,
      tools: async () => ({ notify_act: criticalNotify }),
      policy: approveFor("notify_act"),
      now: () => NOW,
      nowMs: () => Date.parse(NOW),
      audit,
      auditPrincipal: (s) => s,
    });
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });
    expect(action?.tier).toBe("critical");

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toEqual({ ok: true, executed: true });

    const events = await audit.query(scope, { kinds: ["tool_execution"] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ dangerous: true, outcome: "ok" });
  });

  it("a FAILED parked-action execute appends NO tool_execution event (still unresolved, re-askable)", async () => {
    const notify: RegisteredTool = {
      descriptor: { name: "notify_act", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
      execute: async () => ({ ok: false, error: { code: "boom", message: "gmail down" } }),
    };
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
    const run = await runner.fire(scope, automation.id, forEachEnvelope("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toEqual({ ok: false, error: "gmail down" });
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBeUndefined();
    expect(await audit.query(scope, { kinds: ["tool_execution"] })).toHaveLength(0);
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
