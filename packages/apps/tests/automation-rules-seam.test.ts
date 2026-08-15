import { engineOverAdapter } from "@vendoai/core";
/**
 * `Trigger.rules` — the automation's terms in its author's own words — from the
 * plan that wrote them all the way to the row an automation actually runs off,
 * with nothing hand-built in between.
 *
 * The words are display-only, which is exactly why they are easy to lose: no run
 * fails when they go missing, so only a test that walks the whole path notices.
 * And a test that walks HALF the path notices nothing either — a fixture trigger
 * asserted against a fixture schema agrees with itself by construction. So this
 * rides the real public door (`AppsRuntime.automation.author`) and reads the
 * terms back off the STORED row through the ordinary get.
 *
 * The sentences enter through the PLANNER's reply, so they travel the authoring
 * path a real automation's terms travel: plan → `applyAutomationPlan` → the
 * persisted row.
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

const APP_ID = "app_rules_seam";

const ASK = "nudge everyone with an overdue invoice every day";

/**
 * The terms as their author wrote them — including the blank one, deliberately.
 *
 * `triggerSchema.rules` is not `.min(1)` on purpose: this array validates a
 * whole automation, so one sloppy sentence must cost that sentence and never the
 * automation it describes. The blank rides in the MIDDLE, where a validator that
 * rejected it would take the two good sentences down with it.
 */
const RULES = [
  "Caps at $200 a bill — anything higher asks you first.",
  "",
  "Runs once a day and never touches an invoice already paid.",
];

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

/** The automation planner's reply — the ONE thing on this path still running on
 *  the model, and where the terms come from. `planTriggerSchema` is
 *  `triggerSchema.omit({ id: true })`, so `rules` validates here or the plan is
 *  refused outright. */
const PLAN = JSON.stringify({
  name: "Invoice nudge triage",
  trigger: {
    on: { kind: "schedule", every: "1d" },
    run: { kind: "agentic", prompt: "Decide who deserves a gentle vs firm nudge.", budget: { maxToolCalls: 20 } },
    rules: RULES,
  },
});

const respond = (prompt: string): string =>
  prompt.includes("You are the Vendo automation planner") ? PLAN : "";

/** One ride through the real door, returning the runtime it landed in. */
const authorThroughTheDoor = async () => {
  const store = memoryStore();
  const runtime = createApps({
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    model: scriptedLanguageModel((call) => respond(
      call.prompt
        .map((message) => typeof message.content === "string"
          ? message.content
          : message.content.map((part) => part.text ?? "").join(""))
        .join("\n"),
    )),
    armAutomation: async () => ({ enabled: true, missing: [] }),
  });
  await seedAppRow(engineOverAdapter(store), seedDoc, ctx.principal.subject);
  const authored = await runtime.automation.author({ appId: APP_ID, instruction: ASK, mode: "agentic" }, ctx);
  return { runtime, authored };
};

describe("an automation's terms, from the plan that wrote them to the row that runs", () => {
  it("are on the LANDED document, in the author's order, so what a card lists is what runs", async () => {
    const { runtime, authored } = await authorThroughTheDoor();

    // The call really did author an automation — otherwise every assertion
    // below would be about a row nothing wrote.
    expect(authored.ok).toBe(true);

    // Read back through the ordinary door, off the row the authoring persisted.
    const stored = await runtime.get(APP_ID, ctx);
    if (stored === null) throw new Error(`app row ${APP_ID} is gone`);

    expect(stored.triggers?.map(({ id }) => id)).toEqual(["main"]);
    expect(stored.triggers?.[0]?.rules).toEqual(RULES);
    // The blank sentence in the middle is still there: validation dropped
    // nothing, so one sloppy sentence never costs the automation the other two.
    expect(stored.triggers?.[0]?.rules?.[1]).toBe("");
  });
});
