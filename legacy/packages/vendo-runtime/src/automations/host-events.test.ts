/**
 * fireHostEventAutomations: the direct ingest path host events take into the
 * firing pipeline (no Scheduler seam). Covers the two invariants the ingest
 * path guarantees: per-fire failure isolation and per-subject fan-out scoping.
 */
import { describe, expect, it, vi } from "vitest";
import type { Principal } from "@vendoai/core";
import { fireHostEventAutomations } from "./host-events.js";
import { AutomationRunner } from "./runner.js";
import { automationSpecSchema, type AutomationSpec } from "./schema.js";
import type { RegisteredTool } from "./interpreter.js";
import { InMemoryAutomationStore } from "./store.js";

const alice: Principal = { tenantId: "t1", subject: "alice" };
const bob: Principal = { tenantId: "t1", subject: "bob" };

function makeTool(name: string) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: { name, source: "caller", annotations: {}, hasExecute: true, kind: "function" },
    execute: async (input) => {
      calls.push(input);
      return { ok: true, result: { done: true } };
    },
  };
  return tool;
}

function hostEventSpec(event: string): AutomationSpec {
  return automationSpecSchema.parse({
    dslVersion: 1,
    name: `On ${event}`,
    description: "test",
    prompt: "test",
    trigger: { type: "host_event", event },
    execution: {
      mode: "steps",
      steps: [{ id: "send", type: "tool", tool: "send_msg", input: { text: "fired" } }],
    },
  });
}

function setup() {
  const store = new InMemoryAutomationStore();
  const send = makeTool("send_msg");
  const runner = new AutomationRunner({
    store,
    tools: async () => ({ send_msg: send }),
    policy: { evaluate: () => "allow" },
  });
  return { store, send, runner };
}

describe("fireHostEventAutomations", () => {
  it("one automation's firing failure does not starve the other matches", async () => {
    const { store, send, runner } = setup();
    const first = await store.create(alice, { spec: hostEventSpec("invoice.created"), grants: [] });
    const second = await store.create(alice, { spec: hostEventSpec("invoice.created"), grants: [] });

    const realFire = runner.fire.bind(runner);
    const fire = vi
      .spyOn(runner, "fire")
      .mockImplementation(async (scope, automationId, envelope) => {
        if (automationId === first.automation.id) throw new Error("transient store error");
        return realFire(scope, automationId, envelope);
      });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await fireHostEventAutomations({ store, runner }, alice, "invoice.created", {
      eventId: "evt-1",
      payload: { amount: 5000 },
    });

    expect(fire).toHaveBeenCalledTimes(2);
    expect(result.matched).toBe(2);
    expect(result.fired).toBe(1);
    expect(result.runs[0]!.automationId).toBe(second.automation.id);
    expect(send.calls).toHaveLength(1);
    expect(errorLog).toHaveBeenCalledOnce();

    fire.mockRestore();
    errorLog.mockRestore();
  });

  it("fans out only to the subject's own matching automations, never tenant-wide", async () => {
    const { store, send, runner } = setup();
    await store.create(alice, { spec: hostEventSpec("invoice.created"), grants: [] });
    await store.create(bob, { spec: hostEventSpec("invoice.created"), grants: [] });
    await store.create(alice, { spec: hostEventSpec("invoice.paid"), grants: [] });

    const result = await fireHostEventAutomations({ store, runner }, alice, "invoice.created", {
      eventId: "evt-2",
      payload: {},
    });

    expect(result.matched).toBe(1);
    expect(result.fired).toBe(1);
    expect(result.runs[0]!.subject ?? result.runs[0]!.trigger.subject).toBe("alice");
    expect(send.calls).toHaveLength(1);
  });
});
