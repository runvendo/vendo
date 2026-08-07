/**
 * A SECOND automation on an app that already has one.
 *
 * "Add an alert to my dashboard just adds an entry" is the design's flagship
 * sentence, and the object model has carried `triggers[]` since S1 — but every
 * plan the ladder authored landed on the one `main` entry, so the second
 * automation an app was ever asked for silently REPLACED the first. The
 * embedded agent, reading its own result back, answered "I can't set two
 * separate schedules on the same app".
 *
 * This rides the real runtime: real store row, real escalation → plan → server
 * lane → persist, and the host's own arming seam. Nothing is stubbed on the
 * authoring side except the screen agent and the model, because neither can be
 * run here.
 *
 * The host below composes NO sandbox and no machine flags, and both automations
 * are agentic — so this is also the other half of the escalation ladder's law:
 * an agentic automation is one harness run on the agents runtime, and it authors
 * and arms with no machine anywhere.
 */
import { VENDO_APP_FORMAT, type AppDocument, type AppId, type RunContext, type ScreenAssembler, type ToolRegistry } from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { createApps } from "./index.js";
import { guardFixture, memoryStore, scriptedLanguageModel, seedAppRow } from "./testing/index.js";

const APP_ID = "app_two_automations";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_invoices_list",
      description: "Every invoice with its amount and due date.",
      inputSchema: { type: "object" },
      risk: "read",
    }];
  },
  async execute() {
    return { status: "ok", output: { items: [] } };
  },
};

const seedDoc: AppDocument = {
  format: VENDO_APP_FORMAT,
  id: APP_ID,
  name: "Invoice board",
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "app",
    nodes: [{ id: "app", component: "Stack", source: "prewired", children: [] }],
  },
};

/** The two asks, and the two plans the escalating screen agent leaves behind for
 *  them. Both are agentic, so neither declares a results collection and neither
 *  drags a board rewire into a test about the trigger list. */
const NUDGE_ASK = "nudge everyone with an overdue invoice every day";
const NUDGE_WHY = "Each invoice needs a judgment call on how firm the nudge should be.";
const SUMMARY_ASK = "also send me a weekly summary of what got nudged";
const SUMMARY_WHY = "The week's nudges have to be weighed up while nobody has the app open.";

const escalatedPlanText = (title: string, purpose: string, schedule: string, why: string): string =>
  `<Plan name="Invoice board">
  <Group title="${title}">
    <Leaf component="Text" purpose="${purpose}"/>
  </Group>
  <Server kind="agentic" schedule="${schedule}" why="${why}"/>
</Plan>`;

const automationPlan = (
  name: string,
  every: string,
  prompt: string,
  replaces?: string,
): string => JSON.stringify({
  name,
  ...(replaces === undefined ? {} : { replaces }),
  trigger: { on: { kind: "schedule", every }, run: { kind: "agentic", prompt, budget: { maxToolCalls: 20 } } },
});

/** Every automation-planner prompt this run produced, in order. */
const plannerPrompts: string[] = [];

const respond = (prompt: string): string => {
  if (prompt.includes("You are the Vendo automation planner")) {
    plannerPrompts.push(prompt);
    return prompt.includes(SUMMARY_WHY)
      // Deliberately LAZY: the planner is its own model call, and an existing
      // `main` in front of it is an invitation to tidy up. This is what the
      // in-thread walk got — the app came back holding one trigger — so the
      // second automation has to survive a plan that asks to replace the first.
      ? automationPlan("Weekly nudge summary", "7d", "Weigh up the week's nudges and say what mattered.", "main")
      : automationPlan("Invoice nudge triage", "1d", "Decide who deserves a gentle vs firm nudge.");
  }
  return "";
};

const authorBoth = async () => {
  plannerPrompts.length = 0;
  const store = memoryStore();
  const guard = guardFixture();
  /** Every arming the host's seam was asked for, in order. */
  const armed: Array<{ appId: AppId; triggerId: string }> = [];
  /** The ask the screen agent escalated last. `escalatedPlan` is read per app,
   *  not per instruction, so the plan it hands back is the one THIS ask left
   *  behind — which is exactly how the runtime's own escalating agent works. */
  let escalated = "";
  const screen: ScreenAssembler = {
    assemble: async (request) => {
      escalated = request.request;
      return { kind: "escalate", why: "away work no arrangement of components can express" };
    },
  };
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
    screen,
    escalatedPlan: async () => escalated.includes(SUMMARY_ASK)
      ? escalatedPlanText("Weekly summary", "One line saying the weekly summary lands on Fridays", "every Friday", SUMMARY_WHY)
      : escalatedPlanText("Nudges", "One line saying the nudge automation runs daily", "every day", NUDGE_WHY),
    armAutomation: async (appId, triggerId) => {
      armed.push({ appId, triggerId });
      return { enabled: true, missing: [] };
    },
  });
  await seedAppRow(store, seedDoc, ctx.principal.subject);
  const first = await runtime.edit(APP_ID, NUDGE_ASK, ctx);
  const second = await runtime.edit(APP_ID, SUMMARY_ASK, ctx);
  return { runtime, armed, first, second };
};

describe("a second automation on an app that already has one", () => {
  it("lands as an ADDITIONAL entry, leaving the first automation exactly as it was", async () => {
    const { runtime, first, second } = await authorBoth();

    // Both edits really did ride the ladder — otherwise the list assertion
    // below would pass against an app that never authored anything.
    expect(first.failure).toBeUndefined();
    expect(second.failure).toBeUndefined();
    expect(first.automation?.mode).toBe("agentic");
    expect(second.automation?.mode).toBe("agentic");

    const firstTrigger = first.app.triggers?.[0];
    expect(first.app.triggers).toHaveLength(1);
    expect(firstTrigger?.id).toBe("main");

    // The stored row, read back through the ordinary door.
    const stored = await runtime.get(APP_ID, ctx);
    if (stored === null) throw new Error(`app row ${APP_ID} is gone`);
    expect(stored.triggers?.map(({ id }) => id)).toEqual(["main", "weekly_nudge_summary"]);
    expect(stored.triggers?.[0]).toEqual(firstTrigger);
    expect(stored.triggers?.[1]?.on).toEqual({ kind: "schedule", every: "7d" });
    expect(second.automation?.trigger.id).toBe("weekly_nudge_summary");
  });

  it("plans the second automation against the first: the planner is told what this app already runs", async () => {
    await authorBoth();

    // A new app runs nothing, so the first planning says nothing about a list.
    expect(plannerPrompts[0]).not.toContain("THIS APP'S AUTOMATIONS ALREADY");
    // By the second, the app has one — and being able to point at it is the only
    // way a plan can say "this is a new version of THAT one" instead of landing
    // beside it.
    expect(plannerPrompts[1]).toContain("main: schedule 1d — agentic");
    // And it is answering the person's own words, not only the brain's sentence
    // about the away work: "also" is the whole difference between the two asks.
    expect(plannerPrompts[1]).toContain(SUMMARY_ASK);
  });

  it("arms only the automation it just authored: the first one's grants are not revisited", async () => {
    const { armed } = await authorBoth();

    // Arming re-captures a trigger's consent, so touching the sibling here would
    // re-mint grants the person already answered for.
    expect(armed.map(({ triggerId }) => triggerId)).toEqual(["main", "weekly_nudge_summary"]);
    expect(armed.every(({ appId }) => appId === APP_ID)).toBe(true);
  });
});
