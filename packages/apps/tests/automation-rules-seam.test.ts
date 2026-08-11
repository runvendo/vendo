import { engineOverAdapter } from "@vendoai/core";
/**
 * `Trigger.rules` — the automation's terms in its author's own words — from the
 * plan that wrote them all the way to the part the card reads, with nothing
 * hand-built in between.
 *
 * The words are display-only, which is exactly why they are easy to lose: no run
 * fails when they go missing, so only a test that walks the whole path notices.
 * And a test that walks HALF the path notices nothing either — a fixture part
 * asserted against a fixture schema agrees with itself by construction. So this
 * rides the real door (`vendo_make` with `app`, on the real streaming bridge),
 * takes the part OUT of the stream the way the harness bridge does, and puts it
 * through `vendoAutomationPartSchema` — the one gate the bridge applies before
 * any renderer sees a part (`guardedCall` in @vendoai/harnesses).
 *
 * The sentences enter through the PLANNER's reply, so they travel the authoring
 * path a real automation's terms travel: plan → `applyAutomationPlan` → the
 * persisted row → `EditResult.automation.trigger` → the streamed part.
 */
import {
  VENDO_APP_FORMAT,
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  vendoAutomationPartSchema,
  type RunContext,
  type ToolRegistry,
  type VendoAutomationPart,
  type VendoViewStreamUpdate,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import {
  type AppDocument,
  type ScreenAssembler,
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
 * `triggerSchema.rules` is not `.min(1)` on purpose: this array validates a whole
 * automation and, through `vendoAutomationPartSchema`, a whole card, so one
 * sloppy sentence must cost that sentence and never the automation it describes.
 * The blank rides in the MIDDLE, where a validator that rejected it would take
 * the two good sentences down with it.
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

/** The plan the escalating screen agent leaves behind: server-shaped and
 *  agentic, so no results collection and no board rewire come along for the ride. */
const ESCALATED_PLAN = `<Plan name="Invoice board">
  <Group title="Nudges">
    <Leaf component="Text" purpose="One line saying the nudge automation runs daily"/>
  </Group>
  <Server kind="agentic" schedule="every day" why="Each invoice needs a judgment call on how firm the nudge should be."/>
</Plan>`;

const escalatingScreen: ScreenAssembler = {
  assemble: async () => ({ kind: "escalate", why: "nudging every day happens while nobody is watching" }),
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

/** One ride through the real door, returning everything the stream carried. */
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
    screen: escalatingScreen,
    escalatedPlan: async () => ESCALATED_PLAN,
    armAutomation: async () => ({ enabled: true, missing: [] }),
  });
  await seedAppRow(engineOverAdapter(store), seedDoc, ctx.principal.subject);
  const streamed: VendoViewStreamUpdate[] = [];
  const call: VendoViewStreamingToolCall = {
    id: "call_make_rules",
    tool: VENDO_MAKE_TOOL,
    args: { app: APP_ID, request: ASK },
  };
  // Attached exactly the way production attaches it (`makeAppTool` in
  // @vendoai/vendo, `guardedCall` in @vendoai/harnesses) — a symbol property on
  // the call object, which is the only way `stream` is defined inside the tool.
  Object.defineProperty(call, VENDO_VIEW_STREAM, {
    value: (update: VendoViewStreamUpdate) => { streamed.push(update); },
  });
  const outcome = await runtime.agentTools().execute(call, ctx);
  return { runtime, outcome, streamed };
};

/** The automation part as it came off the stream — never built here. */
const automationPart = (streamed: VendoViewStreamUpdate[]): VendoAutomationPart => {
  const update = streamed.find(({ part }) => part.type === "data-vendo-automation");
  if (update === undefined) {
    throw new Error(`no data-vendo-automation part was streamed (got: ${streamed.map(({ part }) => part.type).join(", ") || "nothing"})`);
  }
  return update.part as VendoAutomationPart;
};

describe("an automation's terms, from the plan that wrote them to the streamed part", () => {
  it("reach the part the real make tool emits, in the author's order", async () => {
    const { outcome, streamed } = await authorThroughTheDoor();

    // The call really did author an automation — otherwise every assertion
    // below would be about a part that was never emitted.
    expect(outcome.status).toBe("ok");
    const part = automationPart(streamed);
    expect(part.type).toBe("data-vendo-automation");
    expect(part.trigger?.rules).toEqual(RULES);
  });

  it("survive the gate the bridge applies before any renderer sees the part", async () => {
    const { streamed } = await authorThroughTheDoor();

    const parsed = vendoAutomationPartSchema.safeParse(automationPart(streamed));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.trigger?.rules).toEqual(RULES);
    // The blank sentence in the middle is still there: validation dropped
    // nothing, so one sloppy sentence never costs the card the other two.
    expect(parsed.data?.trigger?.rules?.[1]).toBe("");
  });

  it("are on the LANDED document, so what the card lists is what runs", async () => {
    const { runtime } = await authorThroughTheDoor();

    // Read back through the ordinary door, off the row the edit persisted.
    const stored = await runtime.get(APP_ID, ctx);
    if (stored === null) throw new Error(`app row ${APP_ID} is gone`);

    expect(stored.triggers?.map(({ id }) => id)).toEqual(["main"]);
    expect(stored.triggers?.[0]?.rules).toEqual(RULES);
  });
});
