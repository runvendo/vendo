/**
 * The screen agent (blueprint §4.2) and the escalation seam (§4.5).
 *
 * These are SEAM tests, not loop tests: every case writes through the real
 * `WorkspaceFs` staging + `commit()` path and reads back through the real render
 * seam (`wrapWorkspaceForRender` → `viewForWrite` → the floor's real component
 * gauntlet), with no stub on either side. A harness that mocked the seam would
 * prove only that this file agrees with itself.
 *
 * THE ARTIFACT IS `app.tsx` (`SCREEN_FILE`) — one React component, which the seam
 * paints only by way of `AppFloor.component`. That door is the REAL
 * `createAppFloor` here: esbuild compiles the file, the scan reads it, tsc
 * type-checks it against these very descriptors, and QuickJS renders it once on
 * what the guard-bound registry really answered. Leaving that slot empty is not a
 * lighter test — the seam refuses to paint `app.tsx` at all without it, so every
 * save would silently vanish and the loop would be measured against nothing.
 *
 * What is deliberately a double: the MODEL (scripted provider chunks, so the loop
 * is what is measured) and the one half that needs a STORE — the row a passing
 * screen earns (`AppsRuntime.authoredScreen`, the floor's `delivered`). The real
 * ones — row, queries, receipt — are walked end to end through a composed
 * deployment in `packages/vendo/tests/screen-route.e2e.test.ts`.
 */
import {
  type AppId,
  type Json,
  type ToolDescriptor,
  type VendoViewPart,
} from "@vendoai/core";
import { createAppFloor, SCREEN_FILE, type HostToolInfo } from "@vendoai/apps";
import { describe, expect, it } from "vitest";
import { ESCALATE_TOOL, REPAIR_STEPS, SAVE_APP_TOOL, SCREEN_STEPS, screenAssembler } from "../src/screen-agent.js";
import {
  boundRegistry,
  ctx,
  readTool,
  scriptedModel,
  seats,
  testGuard,
  testWorkspace,
  textTurn,
  toolCallTurn,
  type ScriptedModel,
  type TestWorkspace,
} from "../src/agent-doubles.test-util.js";

const APP = "app_screen" as AppId;

/** A screen every stage of the gauntlet passes, so this is the smallest thing that
 *  can legitimately paint. Its component's NAME is the app's title
 *  (`screenName`) — a `.tsx` file has no other. */
const GOOD_APP = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
    </Stack>
  );
}
`;

/** Not a TSX module at all, so the gauntlet's first stage refuses it — which is
 *  exactly what the seam declines to put on screen. */
const BROKEN_APP = `not a document at all`;

/** A host read tool that DECLARES its result shape. It is EQUIPPED, so that shape
 *  reaches the model as the tool's own JSON Schema and the brief must not restate
 *  it — the field name is a probe for exactly that (below). */
const spendSummary: ToolDescriptor = {
  ...readTool("maple_spend_summary"),
  title: "Spending summary",
  outputSchema: {
    type: "object",
    // A field name that appears NOWHERE in the shipped skill text — the first
    // version of this assertion used `total_cents`, which the skill's own example
    // already contains, so it passed with the shape line deleted.
    properties: { screen_probe_cents: { type: "integer" }, currency: { type: "string" } },
  },
};

/** A MUTATING host tool. Assembly is a read-only job (§4.2, "no mutating host
 *  tools"), so this must never be on the loadout — which is precisely why its
 *  declared shape has to reach the model in PROSE: a screen may still wire a
 *  button to it, and the brief's tool section is the only place the model can
 *  read it. Its probe field is separate from the read tool's, so the two halves of
 *  that split can go red independently. */
const sendMoney: ToolDescriptor = {
  ...readTool("maple_pay", "destructive"),
  title: "Send money",
  outputSchema: {
    type: "object",
    properties: { wire_probe_cents: { type: "integer" }, currency: { type: "string" } },
  },
};

/** `validate` is on the DEPLOYMENT (the save gate and the mandatory check both
 *  call the verb through the registry), and deliberately not on the model's
 *  loadout — every save is gated already, so the verb would only spend steps.
 *
 *  Graded `read`, which is the whole point: that is how the registry really grades
 *  it (`vendo-verbs.ts`'s `DESCRIPTORS`), so the risk half of the loadout filter
 *  would re-equip it and the by-NAME refusal in `screen-agent.ts` is the only thing
 *  that does not. Graded `write` — as this fixture used to be — the risk half
 *  excluded it anyway and the exclusion test proved nothing. */
const validate: ToolDescriptor = { ...readTool("validate") };

/** The assembly verb that is graded `write` on purpose (design §12's mechanical
 *  vote fail-closes a noun-ending name). It is the whole reason the loadout is a
 *  name list unioned with a risk filter rather than a risk filter. */
const searchComponents: ToolDescriptor = { ...readTool("search_components", "write") };

/** `vendo_make` is graded `read`, so a risk filter alone would equip the very
 *  tool that called this loop. */
const vendoMake: ToolDescriptor = { ...readTool("vendo_make") };

interface Harness {
  assemble(request: string): Promise<{ kind: string; why?: string }>;
  emitted: VendoViewPart[];
  workspace: TestWorkspace;
  model: ScriptedModel;
  invocations: Record<string, number>;
  /** The rows a PASSING screen earned — the floor's `delivered`, which is what
   *  `AppsRuntime.authoredScreen` fills in a composed deployment. */
  deliveredCalls: Array<{ appId: AppId; name: string }>;
}

/**
 * One assembler over a REAL workspace and the REAL render seam. `screenAssembler`
 * is what `vendo_make` routes into, so driving it is what proves the route rather
 * than a private helper beside it.
 */
function harness(options: {
  turns: Array<Parameters<typeof scriptedModel>[0][number]>;
  tools?: ToolDescriptor[];
  /** Force every commit to answer `conflict`, so nothing lands. */
  conflict?: boolean;
  /** Guard verdicts by tool name, so a test can take a verb away from the loop. */
  guardPolicy?: Record<string, "run" | "ask" | "block">;
  /** What a named tool answers, for the verbs whose ANSWER is what the loop acts
   *  on (`validate`). Everything else says `{ ok: true }`. */
  answers?: Record<string, Json>;
  /** What composition knows about the component catalog. Unset = it did not say. */
  hasComponents?: boolean;
}): Harness {
  const guard = testGuard(options.guardPolicy);
  const descriptors = options.tools ?? [spendSummary, sendMoney, validate, searchComponents, vendoMake];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => options.answers?.[descriptor.name] ?? { ok: true } },
    ])),
    guard,
  );
  const workspace = testWorkspace();
  const emitted: VendoViewPart[] = [];
  const model = scriptedModel(options.turns);
  const deliveredCalls: Array<{ appId: AppId; name: string }> = [];

  // THE REAL FLOOR. `viewForWrite` paints an `app.tsx` only through
  // `AppFloor.component` — "No door means this build carries no screen engine:
  // nothing paints, the last good view stays" — so this is the read path, not a
  // convenience. `createAppFloor` is the same constructor composition calls
  // (`AppsRuntime.floor`), given the same two outside reaches.
  const floor = createAppFloor({
    deps: async () => ({
      // Kit-only: `screenCatalog` adds the whole Kit to whatever the host
      // registered, and these screens name nothing else.
      catalog: [],
      tools: descriptors.map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
        ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
      })) as HostToolInfo[],
    }),
    // A screen's queries are RUN, through the guard-bound registry — the same
    // binding `screenQueryRunner` gives it in composition. A gauntlet whose stage
    // 4 read from a stub would admit a screen that throws on the real answer.
    runQuery: async (_appId, tool, input) => {
      const outcome = await registry.execute(
        { id: `floor_${tool}_${registry.invocations[tool] ?? 0}`, tool, args: (input ?? {}) as Json },
        ctx(),
      );
      if (outcome.status !== "ok") throw new Error(`${tool} answered ${outcome.status}`);
      return outcome.output;
    },
    // The row half — the ONE double in the floor, because it needs a store.
    delivered: async (input) => {
      deliveredCalls.push(input);
    },
  });

  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => {
      if (options.conflict === true) workspace.conflictOn = ["*"];
      return workspace;
    },
    ...(options.hasComponents === undefined ? {} : { hasComponents: options.hasComponents }),
    render: () => ({ floor }),
  });

  return {
    emitted,
    workspace,
    model,
    invocations: registry.invocations,
    deliveredCalls,
    assemble: async (request: string) => await assembler.assemble(
      { appId: APP, request, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
const escalate = (why: string) => toolCallTurn(ESCALATE_TOOL, { why }, "call_esc");

describe("the loadout (§4.2 — assembly tools only)", () => {
  it("equips the assembly verbs and the host's READ tools, and nothing else", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain("search_components");
    expect(offered).toContain("maple_spend_summary");
    expect(offered).toContain(SAVE_APP_TOOL);
    expect(offered).toContain(ESCALATE_TOOL);
    // The two that must never be there: a mutating host tool, and the front door
    // that called this loop.
    expect(offered).not.toContain("maple_pay");
    expect(offered).not.toContain("vendo_make");
  });

  it("offers no `validate` — the verb is the gate's, not the model's", async () => {
    // The save gate and the mandatory check both call the verb themselves, so a
    // model-facing copy of it buys nothing but steps: the loop's own saves are
    // already floored on the way to the screen.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    expect(screen.model.toolNamesPerCall[0] ?? []).not.toContain("validate");
    // …and it is not offered as something to WIRE either. Refusing to equip a verb
    // drops it into the brief's complement, so `NEVER_WIRED` is what keeps the
    // workshop off the person's screen — "this loop cannot call it" is not the same
    // claim as "hand the person a button for it".
    expect(screen.model.systemPrompts[0] ?? "").not.toContain("validate");
    // …and the save's own answer no longer sends the loop to a tool it has not got.
    const answer = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(answer).toContain("That save landed");
    expect(answer).not.toContain("Run validate on it now");
  });

  it("spends the budget and no more — the cap is the shipped loop's, not a comment", async () => {
    // The screen agent IS `vendo()` with a closed loadout, so the cap it declares
    // has to reach the loop that enforces it. A model that never stops is what
    // measures that: the default resident budget is 20, so an unpassed cap runs
    // every one of these turns.
    const screen = harness({
      turns: Array.from({ length: SCREEN_STEPS + 1 }, () => saveApp(GOOD_APP)),
    });
    await screen.assemble("show me my spending");
    expect(screen.model.calls).toBe(SCREEN_STEPS);
  });

  it("does not equip search_components when the product has no components", async () => {
    // A catalog with nothing in it turns every search into a step spent learning
    // that, and the budget is the definition of cheap. The rest of the loadout is
    // untouched — this is one name dropping out, not a different filter.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], hasComponents: false });
    await screen.assemble("show me my spending");
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).not.toContain("search_components");
    expect(offered).toContain("maple_spend_summary");
    expect(offered).toContain(SAVE_APP_TOOL);
  });

  it("offers no hiring and no discovery — a closed list is total", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    // `vendo()`'s own two additions to any loadout. A fixed menu has nothing to
    // discover, and a cheap first pass does not staff a build.
    expect(offered).not.toContain("hire_subagent");
    expect(offered).not.toContain("find_tools");
  });

  it("writes out the DECLARED shape of a tool the screen can WIRE, and never one it can CALL", async () => {
    // The brief's tool section is the loadout's COMPLEMENT: an equipped tool
    // already arrives with its own description and its own JSON Schema, so
    // restating it would be the same tool twice in one prompt. What is left over is
    // the write side — the tools this loop may never call but an `onClick` may name
    // — and that half exists nowhere else the model can read.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const system = screen.model.systemPrompts[0] ?? "";
    // The wireable half, with the field names a handler needs and no way to learn.
    expect(system).toContain("wire_probe_cents");
    expect(system).toContain("maple_pay — Send money");
    // …and the equipped read tool is absent from the prose entirely, schema and
    // name alike. It is on the model's tool list instead.
    expect(system).not.toContain("screen_probe_cents");
    expect(system).not.toContain("maple_spend_summary");
    expect(screen.model.toolNamesPerCall[0] ?? []).toContain("maple_spend_summary");
    // And the shipped job description, reused rather than restated.
    expect(system).toContain("Write early. Write as you go.");
    // …with its companion file manual beside it, which teaches the ONE artifact.
    expect(system).toContain("# The screen file");
    expect(system).toContain(SCREEN_FILE);
  });
});

describe("assembly writes through the real path and the seam paints it", () => {
  it("a saved app.tsx lands in the workspace and emits ONE settled view", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    const result = await screen.assemble("show me my spending");

    expect(result.kind).toBe("assembled");
    // The real write path: the file is in the workspace, and the commit named it.
    expect(await screen.workspace.readFile(`/user/apps/${APP}/${SCREEN_FILE}`)).toBe(GOOD_APP);
    expect(screen.workspace.commits.at(-1)?.changed).toEqual([`/user/apps/${APP}/${SCREEN_FILE}`]);
    // The real read path: the gauntlet ran the screen and the seam emitted its
    // view. ONE part, and it SETTLES — a component screen's queries are already
    // resolved by the time it renders, so there is no skeleton to send first and
    // nothing left to wait for.
    expect(screen.emitted.map((part) => part.appId)).toEqual([APP]);
    expect(screen.emitted.map((part) => part.payload.streaming)).toEqual([false]);
    // The paint carries what the renderer needs to boot the same screen: the
    // compiled source and the answers it rendered on.
    expect(screen.emitted[0]?.payload["interactive"]).toMatchObject({ compiledSource: expect.any(String) });
    // The row is the GAUNTLET's to grant: its own `ok` is what earns one.
    expect(screen.deliveredCalls).toEqual([{ appId: APP, name: "Spending" }]);
  });

  it("saves as it goes: two saves are two paints on ONE stream id", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), saveApp(GOOD_APP.replace("This month", "Last month")), textTurn("done")],
    });
    await screen.assemble("show me my spending");
    expect(screen.workspace.commits).toHaveLength(2);
    // Successive views reconcile in place — same app, so the same stream.
    expect(new Set(screen.emitted.map((part) => part.appId))).toEqual(new Set([APP]));
  });

  it("a document that does not render paints NOTHING — and the run has nothing to show", async () => {
    const screen = harness({ turns: [saveApp(BROKEN_APP), textTurn("done")] });
    const result = await screen.assemble("show me my spending");
    // The bytes landed (a partial save is legitimate mid-write)…
    expect(screen.workspace.commits).toHaveLength(1);
    // …and the gauntlet refused to put them on screen, so no view and no row.
    expect(screen.emitted).toHaveLength(0);
    expect(screen.deliveredCalls).toHaveLength(0);
    // The front door is what turns this into a fall-through: it finds no ROW.
    expect(result.kind).toBe("assembled");
  });

  /** The gate is FAIL-OPEN by design (`validate-gate.ts`): a validate that could
   *  not run is not a finding. But "could not run" and "ran and found nothing" are
   *  different facts, and this hand reported the second for both — so a loop whose
   *  gate never executed was told its document had been checked and cleared. */
  it("never claims validate cleared a document when the gate could not run at all", async () => {
    const screen = harness({
      turns: [saveApp(BROKEN_APP), textTurn("done")],
      guardPolicy: { validate: "block" },
    });
    await screen.assemble("show me my spending");

    // The note rides back as the save_app tool result, so it is in the next prompt.
    // What it carries is the FLOOR's own refusal — the gauntlet's repair
    // instruction, relayed verbatim — never a verdict from a gate that never ran.
    const note = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(note).toContain("`validate` does not pass");
    expect(note).toContain("does not compile as TSX");
    expect(note).not.toContain("validate found nothing to fix");
    expect(note).not.toContain("That save landed.");
  });

  it("a commit that did not land is told to the model, not swallowed", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], conflict: true });
    const result = await screen.assemble("show me my spending");
    expect(screen.emitted).toHaveLength(0);
    expect(result.kind).toBe("unavailable");
  });
});

describe("the repair round the mandatory check triggers", () => {
  /** A finding, in the shape the `validate` verb reports them — so the gate reads
   *  it exactly as it reads the real floor's. */
  const FINDING = "the total does not match the rows behind it";
  const findsSomething = {
    validate: { ok: false, findings: [{ severity: "block", message: FINDING }] },
  };

  it("spends REPAIR_STEPS and no more, not a second full budget", async () => {
    // The findings name the exact thing to change, so the repair round is capped
    // at a few moves. A model that never stops is what measures it: with the
    // first drive's cap the repair round would run every turn scripted here.
    const screen = harness({
      turns: [
        saveApp(GOOD_APP),
        textTurn("done"),
        ...Array.from({ length: REPAIR_STEPS + 1 }, () => saveApp(GOOD_APP)),
      ],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");
    expect(screen.model.calls).toBe(2 + REPAIR_STEPS);
  });

  it("tells the repair round the budget it actually has", async () => {
    // The brief states the budget, and the repair round's is REPAIR_STEPS. It used
    // to state SCREEN_STEPS on both drives, so a model given three steps was
    // planning for ten.
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("fixed")],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");

    expect(screen.model.systemPrompts[0] ?? "").toContain(`\`${SCREEN_STEPS}\` steps`);
    const repair = screen.model.systemPrompts[2] ?? "";
    expect(repair).toContain(`\`${REPAIR_STEPS}\` steps`);
    expect(repair).not.toContain(`\`${SCREEN_STEPS}\` steps`);
  });

  it("names the finding verbatim, with the document it must fix", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("fixed")],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");
    // The repair round's own first call — the drive after the review pass.
    const repair = JSON.stringify(screen.model.prompts[2] ?? "");
    expect(repair).toContain(FINDING);
    expect(repair).toContain("This is the document you saved");
  });
});

describe("the escalation seam (§4.5)", () => {
  it("hands over one sentence and writes NOTHING — no file, no paint", async () => {
    const screen = harness({
      turns: [escalate("this needs its own server"), textTurn("handed over")],
    });
    const result = await screen.assemble("build me a live trading terminal");

    expect(result).toEqual({ kind: "escalate", why: "this needs its own server" });
    // The person's own ask is the builder's brief, so the hand-off has no artifact
    // of its own: nothing is staged, nothing is committed, and there is nothing to
    // paint until the box builds something.
    expect(screen.workspace.commits).toHaveLength(0);
    expect(screen.emitted).toHaveLength(0);
    expect(screen.deliveredCalls).toHaveLength(0);
  });

  it("escalation wins over a partial paint — 'ready' over a half-built app is the lie §4.5 avoids", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), escalate("it needs real code"), textTurn("handed over")],
    });
    const result = await screen.assemble("build me a trading terminal");
    expect(result.kind).toBe("escalate");
  });

  it("has no consent step: one plain sentence and the work proceeds", async () => {
    const screen = harness({
      turns: [escalate("this needs its own server"), textTurn("handed over")],
    });
    await screen.assemble("build me a live trading terminal");
    // The escalate tool takes ONE reason. Nothing else — no plan to write, no
    // confirmation argument, no question back to the person, no second call to
    // complete it. The hand's own answer says only that it happened.
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain(ESCALATE_TOOL);
    expect(JSON.stringify(screen.model.prompts[1] ?? "")).toContain("handedOver");
  });
});

describe("the guard is the same guard, whichever door", () => {
  it("every host read goes through the guard-bound registry", async () => {
    const screen = harness({
      turns: [toolCallTurn("maple_spend_summary", {}), saveApp(GOOD_APP), textTurn("done")],
    });
    await screen.assemble("show me my spending");
    expect(screen.invocations["maple_spend_summary"]).toBe(1);
  });
});
