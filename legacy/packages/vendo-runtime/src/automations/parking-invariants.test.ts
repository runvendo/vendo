/**
 * ENG-193 §4.6/§8 parking invariants — PERMANENT. Encodes the "park the
 * action, not the run" safety contract (design doc
 * docs/superpowers/specs/2026-07-02-eng193-permissions-design.md §4.6/§8). A
 * PR that breaks one of these is wrong by definition — fix the implementation,
 * never the invariant.
 *
 * Every case runs against the REAL stack: `interpret()` via `AutomationRunner`
 * against `InMemoryAutomationStore` — stub tools only.
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@vendoai/core";
import type { ApprovalPolicy } from "../policy/index.js";
import { AutomationRunner } from "./runner.js";
import { computeGrant } from "./grants.js";
import { automationSpecSchema, type AutomationSpec } from "./schema.js";
import type { RegisteredTool } from "./interpreter.js";
import { InMemoryAutomationStore, type AutomationGrant, type TriggerEnvelope } from "./store.js";

const NOW = "2026-07-04T08:00:00.000Z";
const scope: Principal = { tenantId: "tenant-1", subject: "user-1" };
const approveFor = (...names: string[]): ApprovalPolicy => ({
  evaluate: (ctx) => (names.includes(ctx.toolName) ? "approve" : "allow"),
});

function makeTool(name: string, opts: { destructive?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: {
      name,
      source: "caller",
      annotations: { ...(opts.destructive ? { destructiveHint: true } : {}) },
      hasExecute: true,
      kind: "function",
    },
    execute: async (input) => {
      calls.push(input);
      return { ok: true, result: { done: true } };
    },
  };
  return tool;
}

/** A for_each over `trigger.rows` with one (optionally guarded) tool step. */
function loopSpec(tool: string, opts: { stepIf?: string; before?: unknown[] } = {}): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: "Test",
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event: "transaction.created" },
    execution: {
      mode: "steps",
      steps: [
        ...(opts.before ?? []),
        {
          id: "loop",
          type: "for_each",
          items: "{{ trigger.rows }}",
          maxItems: 5,
          steps: [
            {
              id: "act",
              type: "tool",
              tool,
              input: { row: "{{ item }}" },
              ...(opts.stepIf !== undefined ? { if: opts.stepIf } : {}),
            },
          ],
        },
      ],
    },
  });
}

function rows(eventId: string, items: unknown[]): TriggerEnvelope {
  return { source: "host", eventId, subject: "user-1", occurredAt: NOW, payload: { rows: items } };
}

async function setup(opts: {
  spec: AutomationSpec;
  tools: Record<string, RegisteredTool>;
  policy: ApprovalPolicy;
  grants?: AutomationGrant[];
  userClaims?: (scope: Principal) => Promise<Record<string, unknown>>;
}) {
  const store = new InMemoryAutomationStore({ now: () => NOW });
  const { automation } = await store.create(scope, { spec: opts.spec, grants: opts.grants ?? [] });
  const runner = new AutomationRunner({
    store,
    tools: async () => opts.tools,
    policy: opts.policy,
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
    ...(opts.userClaims ? { userClaims: opts.userClaims } : {}),
  });
  return { store, automation, runner };
}

describe("ENG-193 §4.6/§8 permanent parking invariants", () => {
  it("INVARIANT §8: a CRITICAL tool inside for_each ALWAYS parks, even with a matching grant", async () => {
    const freeze = makeTool("freeze_card", { destructive: true });
    const spec = loopSpec("freeze_card");
    const nested = (
      (spec.execution as { steps: Array<{ steps: Array<{ id: string }> }> }).steps[0]!
    ).steps[0]!;
    // However a grant for a critical tool got into the store, it never buys
    // an unattended execution — criticality is derived from the descriptor,
    // not the grant.
    const grant = computeGrant({
      tool: "freeze_card",
      descriptor: freeze.descriptor,
      spec,
      step: nested as never,
      now: NOW,
    });
    const { store, automation, runner } = await setup({
      spec,
      tools: { freeze_card: freeze },
      policy: approveFor("freeze_card"),
      grants: [grant],
    });

    const run = await runner.fire(scope, automation.id, rows("e1", ["c1"]));
    expect(run?.status).toBe("succeeded");
    expect(freeze.calls).toHaveLength(0);
    const [action] = await store.listParkedActions(scope, { runId: run!.id });
    expect(action?.reason).toBe("critical");
    expect(action?.tier).toBe("critical");
  });

  it("INVARIANT §8: a parked critical approval executes EXACTLY ONCE under concurrent double-approve", async () => {
    const freeze = makeTool("freeze_card", { destructive: true });
    const { store, automation, runner } = await setup({
      spec: loopSpec("freeze_card"),
      tools: { freeze_card: freeze },
      policy: approveFor("freeze_card"),
    });
    const run = await runner.fire(scope, automation.id, rows("e1", ["c1"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const [a, b] = await Promise.all([
      runner.resolveParkedAction(scope, action!.id, "approved"),
      runner.resolveParkedAction(scope, action!.id, "approved"),
    ]);
    expect(freeze.calls).toHaveLength(1);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    const failed = [a, b].find((r): r is { ok: false; error: string } => !r.ok);
    expect(failed?.error).toMatch(/already resolved/);
  });

  it("INVARIANT §8: a DECLINED parked action NEVER executes", async () => {
    const notify = makeTool("notify_act");
    const { store, automation, runner } = await setup({
      spec: loopSpec("notify_act"),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, rows("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const declined = await runner.resolveParkedAction(scope, action!.id, "declined");
    expect(declined).toEqual({ ok: true, executed: false });
    // And no later gesture can revive it: a follow-up approve errors out.
    const late = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(late.ok).toBe(false);
    expect(notify.calls).toHaveLength(0);
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBe("declined");
  });

  it("INVARIANT §8: a parked action past the 7-day TTL is never executable, even via direct resolve replay (bypassing the list sweep)", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: loopSpec("notify_act"), grants: [] });
    let clockMs = Date.parse(NOW);
    const runner = new AutomationRunner({
      store,
      tools: async () => ({ notify_act: notify }),
      policy: approveFor("notify_act"),
      now: () => NOW,
      nowMs: () => clockMs,
    });
    const run = await runner.fire(scope, automation.id, rows("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    clockMs += 8 * 24 * 60 * 60 * 1000; // 8 days later — past the TTL
    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/expired/);
    expect(notify.calls).toHaveLength(0);
    // The row is settled as expired — no later gesture revives it.
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBe("expired");
  });

  it("INVARIANT §8.8: descriptor drift refuses to execute AND leaves the action unresolved (re-askable, never silently declined)", async () => {
    const notify = makeTool("notify_act");
    const store = new InMemoryAutomationStore({ now: () => NOW });
    const { automation } = await store.create(scope, { spec: loopSpec("notify_act"), grants: [] });
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
    const run = await runner.fire(scope, automation.id, rows("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    drifted = true;
    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result.ok).toBe(false);
    expect(notify.calls).toHaveLength(0);
    // Still parked — the surface re-asks with the CURRENT tool identity.
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBeUndefined();
  });

  it("INVARIANT §4.6: a run that parks ≥1 action but otherwise completes finalizes status 'succeeded' — parkedCount is the ONLY signal, never a new status value", async () => {
    const notify = makeTool("notify_act");
    const after = makeTool("after_read");
    after.descriptor.annotations = { readOnlyHint: true };
    const spec = automationSpecSchema.parse({
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
            steps: [{ id: "act", type: "tool", tool: "notify_act", input: { row: "{{ item }}" } }],
          },
          { id: "tail", type: "tool", tool: "after_read" },
        ],
      },
    });
    const { store, automation, runner } = await setup({
      spec,
      tools: { notify_act: notify, after_read: after },
      policy: approveFor("notify_act"),
    });

    const run = await runner.fire(scope, automation.id, rows("e1", ["a", "b"]));
    // The coarse frozen status union is untouched: "succeeded", not some new
    // "parked"/"partial" run-level value.
    expect(run?.status).toBe("succeeded");
    expect(run?.parkedCount).toBe(2);
    expect(after.calls).toHaveLength(1); // the run completed everything it could
    const persisted = await store.getRun(scope, run!.id);
    expect(persisted?.status).toBe("succeeded");
  });

  it("INVARIANT (guard boundary): a guard referencing steps.* is NEVER re-evaluated — guardStale, frozen input executes as-is", async () => {
    const notify = makeTool("notify_act");
    const fetchRows: RegisteredTool = {
      descriptor: { name: "fetch_rows", source: "caller", annotations: {}, hasExecute: true, kind: "function" },
      execute: async () => ({ ok: true, result: { count: 5 } }),
    };
    const spec = loopSpec("notify_act", {
      stepIf: "steps.fetch.output.count > 0",
      before: [{ id: "fetch", type: "tool", tool: "fetch_rows" }],
    });
    const { store, automation, runner } = await setup({
      spec,
      tools: { fetch_rows: fetchRows, notify_act: notify },
      policy: approveFor("notify_act"),
    });
    const run = await runner.fire(scope, automation.id, rows("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });
    expect(action?.guardExpr).toBe("steps.fetch.output.count > 0");

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toMatchObject({ ok: true, executed: true, guardStale: true });
    expect(notify.calls).toEqual([{ row: "a" }]);
  });

  it("INVARIANT (guard boundary): a self-contained guard (trigger/run/user/loop bindings only) IS re-evaluated fresh — a now-false guard skips execution", async () => {
    const notify = makeTool("notify_act");
    // Fresh at park time (guard true), stale by resolve time (guard false).
    let reads = 0;
    const userClaims = async () => {
      reads += 1;
      return { sendOk: reads === 1 };
    };
    const { store, automation, runner } = await setup({
      spec: loopSpec("notify_act", { stepIf: "user.sendOk = true" }),
      tools: { notify_act: notify },
      policy: approveFor("notify_act"),
      userClaims,
    });
    const run = await runner.fire(scope, automation.id, rows("e1", ["a"]));
    const [action] = await store.listParkedActions(scope, { runId: run!.id });

    const result = await runner.resolveParkedAction(scope, action!.id, "approved");
    expect(result).toMatchObject({ ok: true, executed: false, skipped: true });
    expect(notify.calls).toHaveLength(0);
    // The human's yes is still honored as the RESOLUTION — only execution is
    // skipped ("the invoice may have been paid since", spec's own example).
    expect((await store.getParkedAction(scope, action!.id))?.resolution).toBe("approved");
  });
});
