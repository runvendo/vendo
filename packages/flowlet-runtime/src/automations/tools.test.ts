/**
 * Authoring-tool tests: create/update/list/pause/resume/delete/run-now wired
 * over the Principal-scoped store + runner, with closed-world and safe-profile
 * validation at creation time, scope-hashed grant computation, and explicit
 * registration on the frozen Scheduler seam.
 */
import { describe, expect, it } from "vitest";
import type { Tool, ToolCallOptions } from "ai";
import type { Principal, Scheduler, TimeTrigger } from "@flowlet/core";
import { createAutomationTools } from "./tools";
import { AutomationRunner } from "./runner";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore } from "./store";
import { automationSpecSchema } from "./schema";

const NOW = "2026-07-01T08:00:00.000Z";
const scope: Principal = { tenantId: "t1", subject: "user-1" };
const CALL_OPTS = { toolCallId: "tc", messages: [] } as unknown as ToolCallOptions;

function makeTool(
  name: string,
  opts: { readOnly?: boolean; idempotent?: boolean; destructive?: boolean } = {},
) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: {
      name,
      source: "caller",
      annotations: {
        readOnlyHint: opts.readOnly ?? false,
        idempotentHint: opts.idempotent ?? false,
        destructiveHint: opts.destructive ?? false,
      },
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

class FakeScheduler implements Scheduler {
  scheduled = new Map<string, TimeTrigger>();
  cancelled: string[] = [];
  async schedule(id: string, trigger: TimeTrigger): Promise<void> {
    this.scheduled.set(id, trigger);
  }
  async cancel(id: string): Promise<void> {
    this.scheduled.delete(id);
    this.cancelled.push(id);
  }
  onFire(): void {}
}

function validSpec(overrides: Record<string, unknown> = {}) {
  return {
    dslVersion: 1,
    name: "Snitch",
    description: "Post to Slack on late-night delivery",
    prompt: "snitch on me",
    trigger: { type: "host_event", event: "transaction.created" },
    if: "trigger.direction = 'debit'",
    execution: {
      mode: "steps",
      steps: [
        { id: "send", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { text: "{{ trigger.merchant }}" } },
      ],
    },
    ...overrides,
  };
}

function setup() {
  const store = new InMemoryAutomationStore({ now: () => NOW });
  const slack = makeTool("SLACK_SEND_MESSAGE");
  const read = makeTool("maple_list_transactions", { readOnly: true });
  const transfer = makeTool("transfer_money", { destructive: true });
  const registered = {
    SLACK_SEND_MESSAGE: slack,
    maple_list_transactions: read,
    transfer_money: transfer,
  };
  const scheduler = new FakeScheduler();
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: { evaluate: () => "allow" },
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
  });
  const toolset = createAutomationTools({
    store,
    runner,
    scheduler,
    principal: scope,
    registeredTools: async () => registered,
    hostEvents: ["transaction.created"],
    now: () => NOW,
  });
  const exec = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const tool = toolset[name] as Tool;
    return (await tool.execute!(input as never, CALL_OPTS)) as Record<string, unknown>;
  };
  return { store, runner, toolset, exec, slack, scheduler };
}

describe("create_automation", () => {
  it("persists a valid spec, derives the tier, and computes scope-hashed grants", async () => {
    const { store, exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec(),
      grantedTools: ["SLACK_SEND_MESSAGE"],
    });
    expect(result["ok"]).toBe(true);
    const automation = result["automation"] as Record<string, unknown>;
    expect(automation["tier"]).toBe("deterministic");
    expect(automation["status"]).toBe("enabled");

    const version = await store.getVersion(scope, automation["id"] as string, 1);
    expect(version?.grants).toHaveLength(1);
    expect(version?.grants[0]).toMatchObject({ tool: "SLACK_SEND_MESSAGE" });
    expect(version?.grants[0]?.scopeHash).toBeTruthy();
  });

  it("registers schedule triggers on the Scheduler seam with the Principal", async () => {
    const { exec, scheduler } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({
        trigger: { type: "schedule", cron: "0 17 * * 0", timezone: "America/Los_Angeles" },
        if: undefined,
      }),
    });
    expect(result["ok"]).toBe(true);
    const id = (result["automation"] as Record<string, unknown>)["id"] as string;
    expect(scheduler.scheduled.get(id)).toEqual({
      kind: "cron",
      expression: "0 17 * * 0",
      timezone: "America/Los_Angeles",
    });
  });

  it("rejects tools outside the registered closed world without persisting", async () => {
    const { store, exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({
        execution: {
          mode: "steps",
          steps: [{ id: "send", type: "tool", tool: "NOT_A_TOOL", input: {} }],
        },
      }),
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["errors"])).toMatch(/NOT_A_TOOL/);
    expect(await store.list(scope)).toHaveLength(0);
  });

  it("rejects undeclared host events", async () => {
    const { exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({ trigger: { type: "host_event", event: "nope.event" } }),
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["errors"])).toMatch(/nope\.event/);
  });

  it("rejects invalid JSONata inside input templates", async () => {
    const { exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({
        execution: {
          mode: "steps",
          steps: [
            { id: "send", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { text: "{{ trigger.( }}" } },
          ],
        },
      }),
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["errors"])).toMatch(/expression/i);
  });

  it("rejects onError.retry on tools that are not idempotent-safe", async () => {
    const { exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({
        execution: {
          mode: "steps",
          steps: [
            {
              id: "send",
              type: "tool",
              tool: "SLACK_SEND_MESSAGE",
              input: {},
              onError: { strategy: "retry", attempts: 3 },
            },
          ],
        },
      }),
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["errors"])).toMatch(/idempotent/);
  });

  it("INVARIANT §8.3: grantedTools silently excludes dangerous tools", async () => {
    const { store, exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec({
        execution: {
          mode: "steps",
          steps: [
            { id: "move", type: "tool", tool: "transfer_money", input: { amount: 5 } },
            { id: "send", type: "tool", tool: "SLACK_SEND_MESSAGE", input: { text: "done" } },
          ],
        },
      }),
      grantedTools: ["transfer_money", "SLACK_SEND_MESSAGE"],
    });
    expect(result["ok"]).toBe(true); // silent exclusion, not an error
    const id = (result["automation"] as Record<string, unknown>)["id"] as string;
    const version = await store.getVersion(scope, id, 1);
    expect(version?.grants.map((g) => g.tool)).toEqual(["SLACK_SEND_MESSAGE"]);
  });

  it("rejects grantedTools that the spec never references", async () => {
    const { exec } = setup();
    const result = await exec("create_automation", {
      spec: validSpec(),
      grantedTools: ["maple_list_transactions"],
    });
    expect(result["ok"]).toBe(false);
    expect(String(result["errors"])).toMatch(/maple_list_transactions/);
  });
});

describe("lifecycle tools", () => {
  it("update writes a fresh version with fresh grants and cancels pending runs", async () => {
    const { store, exec } = setup();
    const created = await exec("create_automation", {
      spec: validSpec(),
      grantedTools: ["SLACK_SEND_MESSAGE"],
    });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;

    const automation = (await store.get(scope, id))!;
    const pending = await store.createRun(scope, {
      automation,
      version: 1,
      envelope: { source: "host", eventId: "e1", subject: "user-1", occurredAt: NOW, payload: {} },
      isTest: false,
    });
    await store.updateRun(scope, pending.id, {
      outcome: "waiting_approval",
      pendingApproval: {
        stepId: "send",
        tool: "SLACK_SEND_MESSAGE",
        requestedAt: NOW,
        expiresAt: NOW,
        checkpoint: {},
      },
    });

    const updated = await exec("update_automation", {
      id,
      spec: validSpec({ name: "Renamed" }),
      grantedTools: [],
    });
    expect(updated["ok"]).toBe(true);
    expect((await store.get(scope, id))?.currentVersion).toBe(2);
    expect((await store.getVersion(scope, id, 2))?.grants).toEqual([]);
    expect((await store.getRun(scope, pending.id))?.outcome).toBe("cancelled");
  });

  it("pause cancels the schedule, resume re-registers it, delete removes", async () => {
    const { store, exec, scheduler } = setup();
    const created = await exec("create_automation", {
      spec: validSpec({
        trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC" },
        if: undefined,
      }),
    });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;
    expect(scheduler.scheduled.has(id)).toBe(true);

    await exec("pause_automation", { id });
    expect((await store.get(scope, id))?.status).toBe("paused");
    expect(scheduler.scheduled.has(id)).toBe(false);

    await exec("resume_automation", { id });
    expect((await store.get(scope, id))?.status).toBe("enabled");
    expect(scheduler.scheduled.has(id)).toBe(true);

    await exec("delete_automation", { id });
    expect(await store.get(scope, id)).toBeUndefined();
    expect(scheduler.scheduled.has(id)).toBe(false);
  });

  it("refuses to touch another user's automation", async () => {
    const { store, exec } = setup();
    const other: Principal = { tenantId: "t1", subject: "someone-else" };
    const { automation } = await store.create(other, {
      spec: automationSpecSchema.parse(validSpec()),
      grants: [],
    });
    const result = await exec("pause_automation", { id: automation.id });
    expect(result["ok"]).toBe(false);
    expect((await store.get(other, automation.id))?.status).toBe("enabled");
  });

  it("lists only the caller's automations and returns trimmed run history", async () => {
    const { store, exec } = setup();
    const created = await exec("create_automation", { spec: validSpec() });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;
    await store.create(
      { tenantId: "t1", subject: "someone-else" },
      { spec: automationSpecSchema.parse(validSpec()), grants: [] },
    );

    const list = await exec("list_automations", {});
    expect((list["automations"] as unknown[]).length).toBe(1);

    const runs = await exec("get_automation_runs", { id });
    expect(runs["ok"]).toBe(true);
    expect(runs["runs"]).toEqual([]);
  });
});

describe("run_automation_now", () => {
  it("defaults to dry-run: mutating steps simulated, run flagged as test", async () => {
    const { exec, slack } = setup();
    const created = await exec("create_automation", { spec: validSpec() });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;

    const result = await exec("run_automation_now", {
      id,
      samplePayload: { direction: "debit", merchant: "DoorDash" },
    });
    expect(result["ok"]).toBe(true);
    const run = result["run"] as Record<string, unknown>;
    expect(run["isTest"]).toBe(true);
    expect(run["status"]).toBe("succeeded");
    expect(slack.calls).toHaveLength(0);
    const steps = run["steps"] as Array<Record<string, unknown>>;
    expect(steps[0]!["status"]).toBe("simulated");
  });

  it("executes for real with live: true", async () => {
    const { exec, slack } = setup();
    const created = await exec("create_automation", { spec: validSpec() });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;

    const result = await exec("run_automation_now", {
      id,
      samplePayload: { direction: "debit", merchant: "DoorDash" },
      live: true,
    });
    expect((result["run"] as Record<string, unknown>)["status"]).toBe("succeeded");
    expect(slack.calls).toHaveLength(1);
  });
});

describe("annotations", () => {
  it("marks create/update/delete as destructive so policy always gates them", () => {
    const { toolset } = setup();
    for (const name of ["create_automation", "update_automation", "delete_automation"]) {
      const annotations = (toolset[name] as { annotations?: { destructiveHint?: boolean } })
        .annotations;
      expect(annotations?.destructiveHint).toBe(true);
    }
  });
});
