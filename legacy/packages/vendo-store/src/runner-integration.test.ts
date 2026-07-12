/**
 * Assembles the REAL AutomationRunner (packages/vendo-runtime/src/
 * automations/runner.ts) over DrizzleAutomationStore instead of the
 * in-memory store — the engine suite the spec requires against the durable
 * store. Fixture style copied from packages/vendo-runtime/src/automations/
 * runner.test.ts. Each test gets its own fresh in-memory PGlite instance
 * (cheap here since there are only a handful of tests) rather than sharing +
 * truncating, so there's no cross-test bleed to reason about at all.
 */
import { describe, expect, it } from "vitest";
import type { Principal } from "@vendoai/core";
import {
  AutomationRunner,
  automationSpecSchema,
  type ApprovalPolicy,
  type AutomationSpec,
  type RegisteredTool,
  type TriggerEnvelope,
} from "@vendoai/runtime";
import { createVendoDatabase, migrateVendoDatabase } from "./db.js";
import { DrizzleAutomationStore } from "./automation-store.js";

const NOW = "2026-07-01T08:00:00.000Z";
const scope: Principal = { tenantId: "tenant-1", subject: "user-1" };
const allowAll: ApprovalPolicy = { evaluate: () => "allow" };
const approveFor = (...names: string[]): ApprovalPolicy => ({
  evaluate: (ctx) => (names.includes(ctx.toolName) ? "approve" : "allow"),
});

let suffix = 0;
function uniqueDataDir(): string {
  suffix += 1;
  return `memory://runner-integration-${Date.now()}-${suffix}`;
}

function makeTool(name: string, opts: { failTimes?: number } = {}) {
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

function envelope(eventId: string): TriggerEnvelope {
  return {
    source: "host",
    eventId,
    subject: "user-1",
    occurredAt: NOW,
    payload: { merchant: "DoorDash", amountDollars: 87.4 },
  };
}

async function setup(opts: {
  spec?: AutomationSpec;
  tools: Record<string, RegisteredTool>;
  policy?: ApprovalPolicy;
}) {
  const handle = await createVendoDatabase({ pglite: { dataDir: uniqueDataDir() } });
  await migrateVendoDatabase(handle);
  const store = new DrizzleAutomationStore(handle, { now: () => NOW });
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

describe("AutomationRunner over DrizzleAutomationStore", () => {
  it("executes the spec end-to-end and finalizes the run with interpolated tool input", async () => {
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({ tools: { send_msg: send } });

    const run = await runner.fire(scope, automation.id, envelope("e1"));
    expect(run?.status).toBe("succeeded");
    expect(send.calls[0]).toEqual({ text: "DoorDash" });
    expect((await store.get(scope, automation.id))?.counters.totalRuns).toBe(1);
  });

  it("persists waiting_approval with the pending approval, then resumes to completion", async () => {
    const freeze = makeTool("freeze_card");
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({
      spec: spec({
        execution: {
          mode: "steps",
          steps: [
            { id: "freeze", type: "tool", tool: "freeze_card", input: { cardId: "c1" } },
            { id: "send", type: "tool", tool: "send_msg" },
          ],
        },
      }),
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

  it("drops a duplicate envelope as a no-op (DB unique-violation -> DuplicateRunError -> undefined)", async () => {
    const send = makeTool("send_msg");
    const { runner, automation, store } = await setup({ tools: { send_msg: send } });
    await runner.fire(scope, automation.id, envelope("e1"));
    const dup = await runner.fire(scope, automation.id, envelope("e1"));
    expect(dup).toBeUndefined();
    expect(await store.listRuns(scope, automation.id)).toHaveLength(1);
    expect(send.calls).toHaveLength(1);
  });
});
