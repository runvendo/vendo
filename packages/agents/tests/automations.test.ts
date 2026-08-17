import {
  toTriggerSource,
  type AutomationRecord,
  type CreateAutomationInput,
  type Principal,
  type VendoError,
} from "@vendoai/core";
import { createStore } from "@vendoai/store";
import { defineHarness } from "@vendoai/harnesses";
import { describe, expect, it } from "vitest";
import { agent } from "../src/agent.js";
import { agentAutomationPlan, agentAutomations } from "../src/automations.js";

let stores = 0;
const memoryStore = () => createStore({ dataDir: `memory://agents-automations-${stores++}` });

const inert = () => defineHarness({ name: "inert", async *run() {} });

const host: Principal = { kind: "org", subject: "host" };
const NOW = "2026-08-17T00:00:00.000Z";

const support = (name = "support") => agent({ name, harness: inert(), store: memoryStore() });

/** A stored record as the engine would have written the plan's create input —
 *  the second half of the loop a redeploy closes. */
const asStored = (input: CreateAutomationInput, extra: Partial<AutomationRecord> = {}): AutomationRecord => ({
  id: input.id ?? "atm_unminted",
  owner: input.owner,
  when: toTriggerSource(input.when),
  task: input.task,
  ...(input.agent === undefined ? {} : { agent: input.agent }),
  ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
  armed: true,
  authoredBy: input.authoredBy,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra,
});

describe("agent.on() — declaration", () => {
  it("takes all five shapes and returns void", () => {
    const a = support();
    expect(a.on("0 9 * * 1", "summarize the week and email ops")).toBeUndefined();
    a.on({ every: "1d" }, "refresh credit scores");
    a.on({ at: "2099-09-01T09:00:00.000Z" }, "send the launch recap");
    a.on({ event: "payment.failed" }, "triage and notify the user");
    a.on({ webhook: "stripe" }, "reconcile the invoice");
    expect(agentAutomations(a)).toHaveLength(5);
  });

  it("carries the agent's own name — that is the runner-map key the fire looks up", () => {
    const a = support("billing");
    a.on("0 2 * * *", "rebuild the digest");
    expect(agentAutomations(a)[0]).toMatchObject({
      agent: "billing",
      task: { kind: "goal", prompt: "rebuild the digest" },
    });
  });

  it("carries the options bag: id, timezone and budget", () => {
    const a = support();
    a.on("0 2 * * *", "rebuild the digest", {
      id: "nightly-digest",
      timezone: "Europe/London",
      budget: { maxToolCalls: 20 },
    });
    expect(agentAutomations(a)[0]).toEqual({
      id: "nightly-digest",
      when: "0 2 * * *",
      task: { kind: "goal", prompt: "rebuild the digest", budget: { maxToolCalls: 20 } },
      agent: "support",
      timezone: "Europe/London",
    });
  });

  it("an agent that declared nothing has nothing", () => {
    expect(agentAutomations(support())).toEqual([]);
  });

  it("english in the cron slot fails HERE, with what, why, a did-you-mean and the docs", () => {
    const a = support();
    let thrown: VendoError | undefined;
    try {
      a.on("every monday", "summarize the week");
    } catch (error) {
      thrown = error as VendoError;
    }
    expect(thrown?.code).toBe("validation");
    const message = thrown?.message ?? "";
    // All FOUR parts, named one at a time — a three-part error reads fine and
    // still leaves the author without the thing they can paste.
    expect(message).toContain('"every monday" is not a cron expression'); // what
    expect(message).toContain("a cron expression has exactly 5 fields"); // why
    expect(message).toContain('Did you mean "0 9 * * 1"?'); // did-you-mean, and it IS Monday
    expect(message).toContain("https://docs.vendo.run/capabilities/automations"); // docs
    // Declaration-time means nothing was collected: the process fails at module
    // load, not at 2am on a Monday that never comes.
    expect(agentAutomations(a)).toEqual([]);
  });

  it("an empty task fails at declaration too, naming the agent and a shape that works", () => {
    const a = support();
    expect(() => a.on("0 9 * * 1", "   ")).toThrow(/support\.on\(\) was given an empty task/);
    expect(agentAutomations(a)).toEqual([]);
  });
});

describe("boot reconcile", () => {
  it("a new declaration is created, owned by the host and authored by the code", () => {
    const a = support();
    a.on("0 9 * * 1", "summarize the week and email ops");
    const plan = agentAutomationPlan([a], [], host);
    expect(plan.disarm).toEqual([]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]).toMatchObject({
      owner: host,
      when: "0 9 * * 1",
      agent: "support",
      authoredBy: "code",
      task: { kind: "goal", prompt: "summarize the week and email ops" },
    });
  });

  it("a redeploy of unchanged code is a no-op — identity is hash(when + task)", () => {
    const a = support();
    a.on("0 9 * * 1", "summarize the week and email ops");
    const first = agentAutomationPlan([a], [], host);
    const again = agentAutomationPlan([a], [asStored(first.create[0]!)], host);
    expect(again).toEqual({ create: [], disarm: [] });
  });

  it("editing the words mints a NEW identity and disarms the old one", () => {
    const before = support();
    before.on("0 9 * * 1", "summarize the week and email ops");
    const stored = asStored(agentAutomationPlan([before], [], host).create[0]!);

    const after = support();
    after.on("0 9 * * 1", "summarize the week and post it to Slack");
    const plan = agentAutomationPlan([after], [stored], host);

    expect(plan.disarm).toEqual([stored.id]);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0]?.id).not.toBe(stored.id);
  });

  it("a stable id opts out: the same automation survives an edit", () => {
    const before = support();
    before.on("0 9 * * 1", "summarize the week", { id: "weekly" });
    const stored = asStored(agentAutomationPlan([before], [], host).create[0]!);

    const after = support();
    after.on("0 9 * * 1", "summarize the week and post it to Slack", { id: "weekly" });
    const plan = agentAutomationPlan([after], [stored], host);

    expect(plan.disarm).toEqual([]);
    expect(plan.create.map((input) => input.id)).toEqual([stored.id]);
  });

  it("deleting the call disarms the automation — the code was the consent", () => {
    const a = support();
    a.on("0 9 * * 1", "summarize the week");
    const stored = asStored(agentAutomationPlan([a], [], host).create[0]!);

    expect(agentAutomationPlan([support()], [stored], host)).toEqual({ create: [], disarm: [stored.id] });
  });

  it("a manual kill switch survives every redeploy", () => {
    const a = support();
    a.on("0 9 * * 1", "summarize the week");
    const killed = asStored(agentAutomationPlan([a], [], host).create[0]!, {
      armed: false,
      disarmedBy: "user",
    });
    // Neither re-armed by the declaration that still names it, nor disarmed
    // again: a person's decision is not the code's to revisit.
    expect(agentAutomationPlan([a], [killed], host)).toEqual({ create: [], disarm: [] });
    expect(agentAutomationPlan([support()], [killed], host)).toEqual({ create: [], disarm: [] });
  });

  it("chat-authored records are none of the code's business", () => {
    // Same owner as the code reconcile, so it is AUTHORSHIP doing the filtering.
    const chat = asStored({
      id: "atm_chat",
      owner: host,
      when: "0 9 * * 1",
      task: { kind: "goal", prompt: "pay my rent" },
      authoredBy: "chat",
    });
    expect(agentAutomationPlan([support()], [chat], host)).toEqual({ create: [], disarm: [] });
  });

  it("two agents claiming one name are NOT collapsed — the runner map owns that throw", () => {
    const first = support();
    const second = support();
    first.on("0 9 * * 1", "summarize the week");
    second.on("0 9 * * 1", "chase the overdue invoices");
    expect(agentAutomationPlan([first, second], [], host).create.map((input) => input.agent))
      .toEqual(["support", "support"]);
  });
});
