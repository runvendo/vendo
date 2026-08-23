/**
 * What a REMIX may reach — issue #1568.
 *
 * A remix is the ✦ on one of the host's own components, and what it can do is
 * three things: edit that component, read its data, call its declared actions.
 * Authoring an automation is not one of them, and the compound arm of
 * `vendo_make` is how it got in anyway: the recurrence sniff reads the person's
 * OWN words, so a purely COSMETIC wish whose text happens to contain a
 * recurrence word — `a caption that reads "Tracked monthly"` — opened the
 * automation door, armed a schedule nobody asked for, raised a bulk consent
 * prompt at somebody who wanted a text label, and repainted the remix as an
 * empty automation board.
 *
 * The seam under test is `vendo_make` → the ONE create operation, and neither
 * side is stubbed: the make door, the seed door, the edit door, the screen
 * floor, the automation lane and its planner are all the real ones. The engine
 * behind `AutomationsSeam` is a double because it is the block boundary
 * (`automations-double.test-util.ts` says why) — and it is exactly the right
 * observer here, because a record can only exist by passing through its one
 * create operation, so an empty `creates` list IS "no automation was made".
 */
import {
  engineOverAdapter,
  VENDO_APP_FORMAT,
  VENDO_MAKE_TOOL,
  VENDO_VIEW_STREAM,
  type ApprovalRequest,
  type AppDocument,
  type RunContext,
  type ToolOutcome,
  type ToolRegistry,
  type VendoViewStreamUpdate,
  type VendoViewStreamingToolCall,
} from "@vendoai/core";
import type { LanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import type { SeedBaseline } from "../src/contract/index.js";
import type { AgentToolsDataDependencies } from "../src/server/doors/agent-tools.js";
import { runMakeTool } from "../src/server/doors/make-tool.js";
import { createApps, type AppsConfig, type AppsRuntime } from "../src/server/index.js";
import { guardFixture } from "../src/server/testing/guard-fixture.js";
import { memoryStore } from "../src/server/testing/memory-store.js";
import { scriptedLanguageModel, type ScriptedModelCall } from "../src/server/testing/scripted-model.js";
import { scriptedScreenAssembler } from "../src/server/testing/screen-assembler.js";
import { FIXTURE_SCREEN } from "../src/server/testing/screen-document.js";
import { seedAppRow } from "../src/server/testing/seed-app-row.js";
import { fakeAutomations, type FakeAutomations } from "./automations-double.test-util.js";

const ctx: RunContext = {
  principal: { kind: "user", subject: "user_ada" },
  venue: "chat",
  presence: "present",
  sessionId: "session_ada",
};

const SLOT = "net-worth-card";

/** The wish from the field report: cosmetic to the last character, and the
 *  caption's own text carries the word the recurrence sniff looks for. */
const COSMETIC_WISH = 'Add a small caption under the net worth number that reads "Tracked monthly"';

const tools: ToolRegistry = {
  async descriptors() {
    return [{
      name: "host_net_worth",
      description: "The person's current net worth.",
      inputSchema: { type: "object" },
      risk: "read",
    }];
  },
  async execute() {
    return { status: "ok", output: { cents: 120_000_000 } };
  },
};

const baseline: SeedBaseline = {
  slot: SLOT,
  source: "export default function NetWorthCard() {\n  return <strong>$1.2M</strong>;\n}",
  hash: "sha256:maple-base",
  exportable: false,
  capturedAt: "2026-07-14T12:00:00.000Z",
  sampleProps: { valueCents: 120_000_000 },
  ported: { source: FIXTURE_SCREEN, tools: [], holes: [] },
};

/** A plan the real planner's validator accepts, so the control case below really
 *  does arm something — a fix that simply broke compound schedules would pass
 *  every other assertion in this file. */
const PLAN = JSON.stringify({
  name: "Net worth caption",
  when: { every: "1d" },
  task: { kind: "goal", prompt: "Read the net worth and publish what changed.", budget: { maxToolCalls: 5 } },
});

const promptOf = (call: ScriptedModelCall): string => call.prompt.map((message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.map((part) => part.text ?? "").join("")).join("\n");

/** One seat, two readers: the automation planner gets a plan, anything else gets
 *  a valid screen. Branching on the planner's own opening line keeps the two
 *  from answering for each other. */
const model: LanguageModel = scriptedLanguageModel((call) =>
  promptOf(call).includes("You are the Vendo automation planner")
    ? PLAN
    : '<App name="Fixture"><Text text="Fixture"/><Disclaimer reason="Scripted fixture app."/></App>');

/** The consent wall, as the field saw it: an automation that cannot arm until a
 *  pile of scopes is granted. */
const THIRTY_FOUR_SCOPES = Array.from({ length: 34 }, (_, index) => ({
  id: `apr_scope_${index}`,
})) as unknown as ApprovalRequest[];

const hostWith = (
  engine: FakeAutomations,
  /** `failEditsAfter` makes the assembler stop assembling once that many runs
   *  have landed — the browser's own failure mode, where the screen agent tries
   *  to build the schedule into the view and cannot. */
  options: { failEditsAfter?: number } = {},
): { runtime: () => AppsRuntime; store: ReturnType<typeof memoryStore> } => {
  const store = memoryStore();
  let runtime: AppsRuntime;
  let assembled = 0;
  const config: AppsConfig = {
    store,
    guard: guardFixture(),
    tools,
    catalog: [],
    seedBaselines: [baseline],
    automations: engine.seam,
    model,
    screen: scriptedScreenAssembler(() => runtime, (request) => {
      if (options.failEditsAfter !== undefined && assembled >= options.failEditsAfter) {
        return { kind: "unavailable" as const, why: "I couldn't write that change" };
      }
      assembled += 1;
      return `export default function Screen() {\n  return <strong>${JSON.stringify(request.request).slice(1, -1)}</strong>;\n}\n`;
    }),
  };
  runtime = createApps(config);
  return { runtime: () => runtime, store };
};

const makeCall = (args: Record<string, string>): {
  call: VendoViewStreamingToolCall;
  updates: VendoViewStreamUpdate[];
} => {
  const updates: VendoViewStreamUpdate[] = [];
  return {
    call: {
      id: `call_${Object.values(args).join("_").length}`,
      tool: VENDO_MAKE_TOOL,
      args,
      [VENDO_VIEW_STREAM]: (update) => { updates.push(update); },
    },
    updates,
  };
};

const receiptOf = (outcome: ToolOutcome): { id: string; say: string; status: string } => {
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome.output as unknown as { id: string; say: string; status: string };
};

const cardsIn = (updates: VendoViewStreamUpdate[]): VendoViewStreamUpdate[] =>
  updates.filter((update) => update.part.type === "data-vendo-automation");

describe("a cosmetic remix wish reaches no automation door (#1568)", () => {
  it("arms nothing and raises no consent prompt, however its caption reads", async () => {
    const engine = fakeAutomations({ enable: async () => ({ enabled: false, missing: THIRTY_FOUR_SCOPES }) });
    const { runtime } = hostWith(engine);
    const { call, updates } = makeCall({ request: COSMETIC_WISH, component: SLOT });

    const outcome = await runtime().agentTools().execute(call, ctx);

    // The remix itself landed: this is a narrowing, not a refusal.
    const receipt = receiptOf(outcome);
    expect(receipt.status).toBe("ready");
    const remix = await runtime().get(receipt.id as never, ctx);
    expect(remix?.seed?.wishes).toEqual([COSMETIC_WISH]);
    // Nothing passed through the one create operation, so no automation exists…
    expect(engine.creates).toEqual([]);
    expect(engine.records.size).toBe(0);
    // …the app has no automation to name…
    expect(remix?.automations ?? []).toEqual([]);
    // …and nothing asked the person for 34 scopes.
    expect(cardsIn(updates)).toEqual([]);
    // The receipt claims no schedule either — the sniff DOES fire on this wish
    // (that is the whole bug), so what it earns is the redirect below and never
    // a sentence saying something was armed or is waiting on permission.
    expect(receipt.say).not.toMatch(/runs on the schedule|not armed|permission/i);
  });

  it("keeps the door shut on a LATER wish too, which arrives naming the app", async () => {
    // Once a remix exists the ✦ pill is gone — the mark on the fork offers
    // "Edit in chat", whose grounding names the APP (ui/chrome/remixable.tsx),
    // so the follow-up wish never carries `component` again.
    const engine = fakeAutomations();
    const { runtime } = hostWith(engine);
    const minted = receiptOf(await runtime().agentTools().execute(
      makeCall({ request: "Add a caption under the number", component: SLOT }).call,
      ctx,
    ));

    const { call, updates } = makeCall({
      request: 'Add a second caption underneath the first that reads "Updated monthly"',
      app: minted.id,
    });
    const outcome = await runtime().agentTools().execute(call, ctx);

    expect(receiptOf(outcome).status).toBe("ready");
    expect(engine.creates).toEqual([]);
    expect(cardsIn(updates)).toEqual([]);
  });
});

describe("an automation-shaped ask inside a remix (#1568)", () => {
  it("points the person at the main chat instead of dropping the ask in silence", async () => {
    const engine = fakeAutomations();
    const { runtime } = hostWith(engine);
    const { call } = makeCall({
      request: "Show the balance here and email me a summary every monday",
      component: SLOT,
    });

    const outcome = await runtime().agentTools().execute(call, ctx);

    const receipt = receiptOf(outcome);
    expect(receipt.say).toContain("main chat");
    expect(engine.creates).toEqual([]);
  });

  it("points there even when the edit itself could not be made", async () => {
    // The loudest way to drop the ask, found in a browser: asked to "refresh
    // this view every Monday morning", the screen agent tries to BUILD the
    // schedule into the screen and fails, so the receipt is a failure and the
    // person is told only that. A failure is not an answer to where schedules
    // live.
    const engine = fakeAutomations();
    const { runtime } = hostWith(engine, { failEditsAfter: 1 });
    const minted = receiptOf(await runtime().agentTools().execute(
      makeCall({ request: "Add a caption under the number", component: SLOT }).call,
      ctx,
    ));

    const outcome = await runtime().agentTools().execute(
      makeCall({ request: "Also refresh this view every Monday morning", app: minted.id }).call,
      ctx,
    );

    const receipt = receiptOf(outcome);
    expect(receipt.status).toBe("failed");
    expect(receipt.say).toContain("main chat");
    expect(engine.creates).toEqual([]);
  });
});

describe("the read that decides it (#1568)", () => {
  it("fails CLOSED — a row it could not read back never reaches the automation door", async () => {
    // `seed` is the only thing standing between a remix and that door, so a read
    // that did not resolve is not a licence to arm one.
    const engine = fakeAutomations();
    const { runtime, store } = hostWith(engine);
    await seedAppRow(engineOverAdapter(store), {
      format: VENDO_APP_FORMAT,
      id: "app_unreadable",
      name: "Invoice board",
      ui: "tree",
    }, ctx.principal.subject);
    const blind = new Proxy(runtime(), {
      get: (target, property, receiver) => property === "get"
        ? async () => { throw new Error("store hiccup"); }
        : Reflect.get(target, property, receiver) as unknown,
    });
    const { call, updates } = makeCall({
      request: "Add the totals row and refresh it every monday",
      app: "app_unreadable",
    });

    const outcome = await runMakeTool(blind, {} as AgentToolsDataDependencies, call, ctx);

    expect(engine.creates).toEqual([]);
    expect(cardsIn(updates)).toEqual([]);
    expect(receiptOf(outcome).say).toContain("main chat");
  });
});

describe("the blast radius of the narrowing", () => {
  it("leaves an ORDINARY app's compound ask arming exactly as it did", async () => {
    const engine = fakeAutomations();
    const { runtime, store } = hostWith(engine);
    const plain: AppDocument = {
      format: VENDO_APP_FORMAT,
      id: "app_invoice_board",
      name: "Invoice board",
      ui: "tree",
    };
    await seedAppRow(engineOverAdapter(store), plain, ctx.principal.subject);

    const { call, updates } = makeCall({
      request: "Add the totals row and refresh it every monday",
      app: plain.id,
    });
    const outcome = await runtime().agentTools().execute(call, ctx);

    expect(receiptOf(outcome).say).toContain("It runs on the schedule you asked for.");
    expect(engine.creates).toHaveLength(1);
    expect(cardsIn(updates)).toHaveLength(1);
  });
});
