/**
 * The screen agent (blueprint §4.2) and the escalation seam (§4.5).
 *
 * These are SEAM tests, not loop tests: every case writes through the real
 * `WorkspaceFs` staging + `commit()` path and reads back through the real render
 * seam (`wrapWorkspaceForRender` → `viewForWrite` → `compileWire` / `compilePlan`
 * → `skeletonFromPlan`), with no stub on either side. A harness that mocked the
 * seam would prove only that this file agrees with itself.
 *
 * What is deliberately a double: the MODEL (scripted provider chunks, so the loop
 * is what is measured) and the app half of an `app.vendo` commit
 * (`AppsRuntime.authored`, which needs a store). The real app half — row, queries,
 * receipt — is walked end to end through a composed deployment in
 * `packages/vendo/src/screen-route.e2e.test.ts`.
 *
 * DIALECT NOTE: the `.vendo` literals below are the minimum needed to make the
 * compiler parse something, and the wire dialect is changing under this lane
 * (pipes → nested calls, explicit aggregate field args, `avg` retires). They use
 * no expressions and no aggregates, so they should survive — but they are the text
 * to re-check when the new dialect lands.
 */
import {
  type AppId,
  type Json,
  type ToolDescriptor,
  type VendoViewPart,
  type WireCompileResult,
} from "@vendoai/core";
import { describe, expect, it } from "vitest";
import { ESCALATE_TOOL, SAVE_APP_TOOL, SCREEN_STEPS, screenAssembler } from "../src/screen-agent.js";
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

/** A document the compiler renders: one node under the root is the seam's whole
 *  gate (`renders`), so this is the smallest thing that can legitimately paint. */
const GOOD_APP = `<App name="Spending">
  <Stack>
    <Text value="This month" />
  </Stack>
</App>`;

/** Unparseable: `compileWire` is total, so this yields a childless synthetic root
 *  — which is exactly what the seam refuses to put on screen. */
const BROKEN_APP = `not a document at all`;

const GOOD_PLAN = `<Plan name="Spending">
  <Group title="Overview">
    <Leaf component="Stat" />
  </Group>
</Plan>`;

/** A host read tool that DECLARES its result shape, so the brief can carry field
 *  names the model would otherwise have to call once to learn. */
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
 *  tools"), so this must never be on the loadout. */
const sendMoney: ToolDescriptor = { ...readTool("maple_pay", "destructive"), title: "Send money" };

/** The two assembly verbs that are graded `write` on purpose (design §12's
 *  mechanical vote fail-closes a noun-ending name). They are the whole reason the
 *  loadout is a name list unioned with a risk filter rather than a risk filter. */
const validate: ToolDescriptor = { ...readTool("validate", "write") };
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
  authoredCalls: Array<{ appId: AppId; compiled: WireCompileResult }>;
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
  authoredApp?: boolean;
  /** Guard verdicts by tool name, so a test can take a verb away from the loop. */
  guardPolicy?: Record<string, "run" | "ask" | "block">;
}): Harness {
  const guard = testGuard(options.guardPolicy);
  const descriptors = options.tools ?? [spendSummary, sendMoney, validate, searchComponents, vendoMake];
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      { descriptor, execute: (): Json => ({ ok: true }) },
    ])),
    guard,
  );
  const workspace = testWorkspace();
  const emitted: VendoViewPart[] = [];
  const model = scriptedModel(options.turns);
  const authoredCalls: Array<{ appId: AppId; compiled: WireCompileResult }> = [];

  const assembler = screenAssembler({
    models: seats(model),
    tools: registry,
    workspace: async () => {
      if (options.conflict === true) workspace.conflictOn = ["*"];
      return workspace;
    },
    render: () => ({
      facts: () => ({ tools: descriptors.map((descriptor) => descriptor.name), components: ["Stat", "Text"] }),
      ...(options.authoredApp === false ? {} : {
        authoredApp: async (input) => {
          authoredCalls.push(input);
          return { data: {} };
        },
      }),
    }),
  });

  return {
    emitted,
    workspace,
    model,
    invocations: registry.invocations,
    authoredCalls,
    assemble: async (request: string) => await assembler.assemble(
      { appId: APP, request, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
const escalate = (plan: string, why: string) => toolCallTurn(ESCALATE_TOOL, { plan, why }, "call_esc");

describe("the loadout (§4.2 — assembly tools only)", () => {
  it("equips the assembly verbs and the host's READ tools, and nothing else", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain("validate");
    expect(offered).toContain("search_components");
    expect(offered).toContain("maple_spend_summary");
    expect(offered).toContain(SAVE_APP_TOOL);
    expect(offered).toContain(ESCALATE_TOOL);
    // The two that must never be there: a mutating host tool, and the front door
    // that called this loop.
    expect(offered).not.toContain("maple_pay");
    expect(offered).not.toContain("vendo_make");
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

  it("offers no hiring and no discovery — a closed list is total", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    // `vendo()`'s own two additions to any loadout. A fixed menu has nothing to
    // discover, and a cheap first pass does not staff a build.
    expect(offered).not.toContain("hire_subagent");
    expect(offered).not.toContain("find_tools");
  });

  it("carries the host's DECLARED result shape into the brief, not a sampled guess", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const system = screen.model.systemPrompts[0] ?? "";
    // The field names the model would otherwise have to call the tool once to learn.
    expect(system).toContain("screen_probe_cents");
    expect(system).toContain("maple_spend_summary — Spending summary");
    // And the shipped job description, reused rather than restated.
    expect(system).toContain("Write early. Write as you go.");
    // …with its companion syntax manual beside it.
    expect(system).toContain("<Plan");
  });
});

describe("assembly writes through the real path and the seam paints it", () => {
  it("a saved app.vendo lands in the workspace and emits ONE settled view", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    const result = await screen.assemble("show me my spending");

    expect(result.kind).toBe("assembled");
    // The real write path: the file is in the workspace, and the commit named it.
    expect(await screen.workspace.readFile(`/user/apps/${APP}/app.vendo`)).toBe(GOOD_APP);
    expect(screen.workspace.commits.at(-1)?.changed).toEqual([`/user/apps/${APP}/app.vendo`]);
    // The real read path: the seam compiled it and emitted the view part.
    expect(screen.emitted.map((part) => part.appId)).toEqual([APP, APP]);
    // Skeleton first (the app half runs real queries), then the settled paint.
    expect(screen.emitted.map((part) => part.payload.streaming)).toEqual([true, false]);
    // And the app half got the compile the paint was made from — byte-identical
    // by construction, which is why `authored` takes it rather than recompiling.
    expect(screen.authoredCalls).toHaveLength(1);
    expect(screen.authoredCalls[0]?.appId).toBe(APP);
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
    // …and the seam refused to put them on screen, so no row and no app half.
    expect(screen.emitted).toHaveLength(0);
    expect(screen.authoredCalls).toHaveLength(0);
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
    const note = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(note).toContain("did not reach the person's screen");
    expect(note).not.toContain("validate found nothing to fix");
  });

  it("a commit that did not land is told to the model, not swallowed", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], conflict: true });
    const result = await screen.assemble("show me my spending");
    expect(screen.emitted).toHaveLength(0);
    expect(result.kind).toBe("unavailable");
  });
});

describe("the escalation seam (§4.5)", () => {
  it("writes plan.vendo through the real commit path and the seam paints its skeleton", async () => {
    const screen = harness({
      turns: [escalate(GOOD_PLAN, "this needs its own server"), textTurn("handed over")],
    });
    const result = await screen.assemble("build me a live trading terminal");

    expect(result).toEqual({ kind: "escalate", why: "this needs its own server" });
    // Real write path.
    expect(await screen.workspace.readFile(`/user/apps/${APP}/plan.vendo`)).toBe(GOOD_PLAN);
    expect(screen.workspace.commits.at(-1)?.changed).toEqual([`/user/apps/${APP}/plan.vendo`]);
    // Real read path: `compilePlan` → `skeletonFromPlan` → the view. NOTHING here
    // is stubbed — the plan branch of the seam never calls the app half at all.
    expect(screen.emitted).toHaveLength(1);
    expect(screen.emitted[0]?.appId).toBe(APP);
    // A plan IS the mid-build state, so its skeleton stays streaming until the
    // builder's own app document lands on the same stream id.
    expect(screen.emitted[0]?.payload.streaming).toBe(true);
    expect(screen.authoredCalls).toHaveLength(0);
  });

  it("escalation wins over a partial paint — 'ready' over a half-built app is the lie §4.5 avoids", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), escalate(GOOD_PLAN, "it needs real code"), textTurn("handed over")],
    });
    const result = await screen.assemble("build me a trading terminal");
    expect(result.kind).toBe("escalate");
  });

  it("has no consent step: one plain sentence and the work proceeds", async () => {
    const screen = harness({
      turns: [escalate(GOOD_PLAN, "this needs its own server"), textTurn("handed over")],
    });
    await screen.assemble("build me a live trading terminal");
    // The escalate tool takes a plan and a reason. Nothing else — no confirmation
    // argument, no question back to the person, no second call to complete it.
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain(ESCALATE_TOOL);
    expect(screen.workspace.commits).toHaveLength(1);
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
