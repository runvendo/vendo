/**
 * Authoring-tool tests: create/update/list/pause/resume/delete/run-now wired
 * over the store + runner, with closed-world and safe-profile validation at
 * creation time and scope-hashed grant computation.
 */
import { describe, expect, it } from "vitest";
import type { Tool, ToolCallOptions } from "ai";
import { createAutomationTools } from "./tools";
import { AutomationRunner } from "./runner";
import type { RegisteredTool } from "./interpreter";
import { InMemoryAutomationStore } from "./store";

const NOW = "2026-07-01T08:00:00.000Z";
const CALL_OPTS = { toolCallId: "tc", messages: [] } as unknown as ToolCallOptions;

function makeTool(name: string, opts: { readOnly?: boolean; idempotent?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const tool: RegisteredTool & { calls: typeof calls } = {
    calls,
    descriptor: {
      name,
      source: "caller",
      annotations: { readOnlyHint: opts.readOnly ?? false, idempotentHint: opts.idempotent ?? false },
      hasExecute: true,
      kind: "function",
    },
    execute: async (input) => {
      calls.push(input);
      return { ok: true };
    },
  };
  return tool;
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
  const store = new InMemoryAutomationStore();
  const slack = makeTool("SLACK_SEND_MESSAGE");
  const read = makeTool("maple_list_transactions", { readOnly: true });
  const registered = { SLACK_SEND_MESSAGE: slack, maple_list_transactions: read };
  const runner = new AutomationRunner({
    store,
    tools: async () => registered,
    policy: { evaluate: () => "allow" },
    principal: { userId: "user-1" },
    now: () => NOW,
    nowMs: () => Date.parse(NOW),
  });
  const toolset = createAutomationTools({
    store,
    runner,
    tenantId: "t1",
    userId: "user-1",
    registeredTools: async () => registered,
    hostEvents: ["transaction.created"],
    now: () => NOW,
  });
  const exec = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
    const tool = toolset[name] as Tool;
    return (await tool.execute!(input as never, CALL_OPTS)) as Record<string, unknown>;
  };
  return { store, runner, toolset, exec, slack };
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

    const version = await store.getVersion(automation["id"] as string, 1);
    expect(version?.grants).toHaveLength(1);
    expect(version?.grants[0]).toMatchObject({ tool: "SLACK_SEND_MESSAGE" });
    expect(version?.grants[0]?.scopeHash).toBeTruthy();
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
    expect(await store.listAutomations()).toHaveLength(0);
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

    const automation = (await store.getAutomation(id))!;
    const pending = await store.createRun({
      automation,
      version: 1,
      envelope: { source: "host", eventId: "e1", subject: "user-1", occurredAt: NOW, payload: {} },
      isTest: false,
      now: NOW,
    });
    await store.updateRun(pending.id, {
      status: "waiting_approval",
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
    expect((await store.getAutomation(id))?.currentVersion).toBe(2);
    expect((await store.getVersion(id, 2))?.grants).toEqual([]);
    expect((await store.getRun(pending.id))?.status).toBe("cancelled");
  });

  it("pause cancels pending runs, resume re-enables, delete removes", async () => {
    const { store, exec } = setup();
    const created = await exec("create_automation", { spec: validSpec() });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;

    await exec("pause_automation", { id });
    expect((await store.getAutomation(id))?.status).toBe("paused");
    await exec("resume_automation", { id });
    expect((await store.getAutomation(id))?.status).toBe("enabled");
    await exec("delete_automation", { id });
    expect(await store.getAutomation(id)).toBeUndefined();
  });

  it("refuses to touch another user's automation", async () => {
    const { store, exec } = setup();
    const { automation: other } = await store.createAutomation({
      tenantId: "t1",
      userId: "someone-else",
      spec: (await import("./schema")).automationSpecSchema.parse(validSpec()),
      grants: [],
      now: NOW,
    });
    const result = await exec("pause_automation", { id: other.id });
    expect(result["ok"]).toBe(false);
    expect((await store.getAutomation(other.id))?.status).toBe("enabled");
  });

  it("lists only the caller's automations and returns trimmed run history", async () => {
    const { store, exec } = setup();
    const created = await exec("create_automation", { spec: validSpec() });
    const id = (created["automation"] as Record<string, unknown>)["id"] as string;
    await store.createAutomation({
      tenantId: "t1",
      userId: "someone-else",
      spec: (await import("./schema")).automationSpecSchema.parse(validSpec()),
      grants: [],
      now: NOW,
    });

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
