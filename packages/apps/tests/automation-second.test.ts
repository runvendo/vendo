import { engineOverAdapter } from "@vendoai/core";
/**
 * A SECOND automation on an app that already has one.
 *
 * "Add an alert to my dashboard just adds an entry" is the design's flagship
 * sentence — but every plan the authoring path produced landed on the one entry
 * the app already had, so the second automation an app was ever asked for
 * silently REPLACED the first. The
 * embedded agent, reading its own result back, answered "I can't set two
 * separate schedules on the same app". An automation is its own record now, and
 * an app names a LIST of them — but the same lazy plan still has to be refused.
 *
 * This rides the real runtime through the public automation door: real store
 * row, real plan → lane → persist, and the automations seam. Only the model and
 * the engine behind the seam are stubbed — the model cannot be run here, and the
 * engine is another block this one may not import.
 *
 * The host below composes NO sandbox and no machine flags, and both automations
 * are agentic — so this is also the door's own law: authoring an automation
 * never needed a machine, and it authors and arms with none anywhere.
 */
import {
  VENDO_APP_FORMAT,
  type RunContext,
  type ToolRegistry,
} from "@vendoai/core";
import {
  type AppDocument,
} from "../src/contract/index.js";
import { describe, expect, it } from "vitest";
import { createApps } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel } from "../src/server/testing/scripted-model.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { fakeAutomations } from "./automations-double.test-util.js";

const APP_ID = "app_two_automations";
/** The id the double mints for the first record, so the lazy plan below can ask
 *  to replace exactly it. */
const FIRST_ID = "atm_fake1";

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

/** The two asks. Both are authored agentic, so neither declares a results
 *  collection and neither drags a board rewire into a test about the app's
 *  automations list. */
const NUDGE_ASK = "nudge everyone with an overdue invoice every day";
const SUMMARY_ASK = "also send me a weekly summary of what got nudged";

const automationPlan = (
  name: string,
  every: string,
  prompt: string,
  replaces?: string,
): string => JSON.stringify({
  name,
  ...(replaces === undefined ? {} : { replaces }),
  when: { every },
  task: { kind: "goal", prompt, budget: { maxToolCalls: 20 } },
});

/** Every automation-planner prompt this run produced, in order. */
const plannerPrompts: string[] = [];

const respond = (prompt: string): string => {
  if (prompt.includes("You are the Vendo automation planner")) {
    plannerPrompts.push(prompt);
    return prompt.includes(SUMMARY_ASK)
      // Deliberately LAZY: the planner is its own model call, and an existing
      // automation in front of it is an invitation to tidy up. This is what the
      // in-thread walk got — the app came back holding one — so the second
      // automation has to survive a plan that asks to replace the first.
      ? automationPlan("Weekly nudge summary", "7d", "Weigh up the week's nudges and say what mattered.", FIRST_ID)
      : automationPlan("Invoice nudge triage", "1d", "Decide who deserves a gentle vs firm nudge.");
  }
  return "";
};

const authorBoth = async () => {
  plannerPrompts.length = 0;
  const store = memoryStore();
  const guard = guardFixture();
  /** Every arming the engine was asked for, in order. */
  const armed: string[] = [];
  const engine = fakeAutomations({
    enable: async (id) => {
      armed.push(id);
      return { enabled: true, missing: [] };
    },
  });
  const runtime = createApps({
    store,
    guard,
    tools,
    catalog: [],
    automations: engine.seam,
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
  });
  await seedAppRow(engineOverAdapter(store), seedDoc, ctx.principal.subject);
  const first = await runtime.automation.author({ appId: APP_ID, instruction: NUDGE_ASK, mode: "goal" }, ctx);
  const second = await runtime.automation.author({ appId: APP_ID, instruction: SUMMARY_ASK, mode: "goal" }, ctx);
  return { runtime, armed, first, second, engine };
};

describe("a second automation on an app that already has one", () => {
  it("lands as an ADDITIONAL record, leaving the first automation exactly as it was", async () => {
    const { runtime, first, second, engine } = await authorBoth();

    // Both calls really did author something — otherwise the list assertion
    // below would pass against an app that never authored anything.
    if (!first.ok || !second.ok) throw new Error(`authoring failed: ${JSON.stringify([first, second])}`);

    expect(first.document.automations).toEqual([FIRST_ID]);
    expect(second.record.id).not.toBe(FIRST_ID);

    // The stored row, read back through the ordinary door.
    const stored = await runtime.get(APP_ID, ctx);
    if (stored === null) throw new Error(`app row ${APP_ID} is gone`);
    expect(stored.automations).toEqual([FIRST_ID, second.record.id]);
    // The first record's own content is untouched by the second authoring.
    expect(engine.records.get(FIRST_ID)?.when).toEqual({ kind: "schedule", every: "1d" });
    expect(engine.records.get(second.record.id)?.when).toEqual({ kind: "schedule", every: "7d" });
  });

  it("plans the second automation against the first: the planner is told what this app already runs", async () => {
    await authorBoth();

    // A new app runs nothing, so the first planning says nothing about a list.
    expect(plannerPrompts[0]).not.toContain("THIS APP'S AUTOMATIONS ALREADY");
    // By the second, the app has one — and being able to point at it is the only
    // way a plan can say "this is a new version of THAT one" instead of landing
    // beside it.
    expect(plannerPrompts[1]).toContain(`${FIRST_ID}: on schedule 1d — goal`);
    // And it is answering the person's own words: "also" is the whole
    // difference between the two asks.
    expect(plannerPrompts[1]).toContain(SUMMARY_ASK);
  });

  it("arms only the automation it just authored: the first one's grants are not revisited", async () => {
    const { armed, second } = await authorBoth();
    if (!second.ok) throw new Error("authoring failed");

    // Arming re-captures a record's consent, so touching the sibling here would
    // re-mint grants the person already answered for.
    expect(armed).toEqual([FIRST_ID, second.record.id]);
  });
});
