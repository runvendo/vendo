/**
 * The screen agent (blueprint §4.2).
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
  setLogger,
  type AppId,
  type Json,
  type RunContext,
  type ToolDescriptor,
  type VendoLogEvent,
  type VendoViewPart,
} from "@vendoai/core";
import { createAppFloor, SCREEN_FILE, type HostToolInfo } from "@vendoai/apps";
import { afterEach, describe, expect, it } from "vitest";
import { EDIT_APP_TOOL, REPAIR_STEPS, SAVE_APP_TOOL, SCREEN_STEPS, screenAssembler } from "../src/screen-agent.js";
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
  type StreamPart,
  type TestWorkspace,
} from "../src/agent-doubles.test-util.js";

afterEach(() => {
  setLogger(undefined);
});

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

/** Two passages a repair can quote separately — the smallest screen that can
 *  prove a batch of edits lands as one. */
const TWO_TEXT_APP = `import { Stack, Text } from "@vendo/screen";

export default function Spending() {
  return (
    <Stack gap={12}>
      <Text text="This month" variant="heading" />
      <Text text="Last month" />
    </Stack>
  );
}
`;

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
 *  tools"), so this must never be on the loadout — which is precisely why what a
 *  handler must SEND it has to reach the model in PROSE: a screen may still wire
 *  a button to it, and the brief's tool section is the only place that says what
 *  goes in the call. Its probe field is separate from the read tool's, so the two
 *  halves of that split can go red independently.
 *
 *  What it RETURNS is deliberately NOT in the brief — the briefing pack's shape
 *  card carries every tool's response — so the output probe below is asserted
 *  ABSENT. */
const sendMoney: ToolDescriptor = {
  ...readTool("maple_pay", "destructive"),
  title: "Send money",
  inputSchema: {
    type: "object",
    required: ["wire_probe_cents"],
    properties: { wire_probe_cents: { type: "integer" }, currency: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { wire_return_probe: { type: "integer" } },
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

/** An assembly verb graded `write` on purpose. It is the whole reason the loadout
 *  is a name list unioned with a risk filter rather than a risk filter. */
const askUser: ToolDescriptor = { ...readTool("ask_user", "write") };

/** `vendo_make` is graded `read`, so a risk filter alone would equip the very
 *  tool that called this loop. */
const vendoMake: ToolDescriptor = { ...readTool("vendo_make") };

/** The two verbs that read an app that already exists, graded `read` exactly as
 *  the registry grades them — which is how they rode onto a FRESH build's loadout,
 *  where the app is the file the run has not written yet. */
const appsOpen: ToolDescriptor = { ...readTool("vendo_apps_open") };
const appsDataList: ToolDescriptor = { ...readTool("vendo_apps_data_list") };

/** Machinery on the same `read` grade: WHERE a view goes is the caller's question,
 *  and a writer handed the verb is a writer handed the workshop. */
const slotsList: ToolDescriptor = { ...readTool("vendo_slots_list") };

interface Harness {
  assemble(request: string): Promise<{ kind: string; why?: string; say?: string }>;
  emitted: VendoViewPart[];
  workspace: TestWorkspace;
  model: ScriptedModel;
  invocations: Record<string, number>;
  /** What each tool was CALLED WITH, in order — for the verbs whose arguments are
   *  the thing under test (`validate` carries the person's ask). */
  toolArgs: Record<string, Json[]>;
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
  /** The runtime's memory door, for the tests about what a REFUSING one costs. */
  remember?: (appId: AppId, decisions: string, ctx: RunContext) => Promise<void>;
  /** The document this app ALREADY has, which is what makes a run an edit rather
   *  than a fresh build — no mode flag exists, and the file's presence is the
   *  distinction the loop reads. */
  existing?: string;
  /** The spec version the model REPORTS, for the tests where the seat's own gate
   *  is what is under test. An ai@6-era provider says "v3" and an ai@7-era one
   *  says "v4"; `ai/test` ships a v4 double only on the newer major, and ai@7's
   *  own v3→v4 adapter (`asLanguageModelV4`) is exactly this relabel, so the
   *  label is the whole of the difference on either major. */
  spec?: "v3" | "v4";
  /** Compose with NO checks floor, which is a deployment carrying no screen
   *  engine: the seam has no door to paint through, so every save lands its bytes
   *  and reaches nobody. */
  screenEngine?: false;
}): Harness {
  const guard = testGuard(options.guardPolicy);
  const descriptors = options.tools
    ?? [spendSummary, sendMoney, validate, askUser, vendoMake, appsOpen, appsDataList, slotsList];
  const toolArgs: Record<string, Json[]> = {};
  const registry = boundRegistry(
    Object.fromEntries(descriptors.map((descriptor) => [
      descriptor.name,
      {
        descriptor,
        execute: (args: Json): Json => {
          (toolArgs[descriptor.name] ??= []).push(args);
          return options.answers?.[descriptor.name] ?? { ok: true };
        },
      },
    ])),
    guard,
  );
  const workspace = testWorkspace(
    options.existing === undefined ? {} : { [`/user/apps/${APP}/${SCREEN_FILE}`]: options.existing },
  );
  const emitted: VendoViewPart[] = [];
  const model = scriptedModel(options.turns);
  if (options.spec !== undefined) Object.assign(model, { specificationVersion: options.spec });
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
    render: () => (options.screenEngine === false ? {} : { floor }),
    ...(options.remember === undefined ? {} : { remember: options.remember }),
  });

  return {
    emitted,
    workspace,
    model,
    invocations: registry.invocations,
    toolArgs,
    deliveredCalls,
    assemble: async (request: string) => await assembler.assemble(
      { appId: APP, request, onView: (part) => emitted.push(part) },
      ctx(),
    ),
  };
}

const saveApp = (content: string) => toolCallTurn(SAVE_APP_TOOL, { content });
/** One edit hand call, however many passages it carries. */
type Patch = { find: string; replace: string };
const editApp = (edits: Patch[], id = "call_edit") => toolCallTurn(EDIT_APP_TOOL, { edits }, id);
/** One turn that SAYS something and acts on it — the shape a provider really
 *  sends when the model writes its closing words beside its last save. */
const sayAndSave = (say: string, content: string): StreamPart[] => [
  ...textTurn(say).slice(0, -1),
  ...saveApp(content),
];
/** The same shape on the edit hand: the words and the patch in one breath. */
const sayAndEdit = (say: string, edits: Patch[]): StreamPart[] => [
  ...textTurn(say).slice(0, -1),
  ...editApp(edits),
];
/** TWO hands in ONE step — a provider sends parallel tool calls, so this is a
 *  shape the loop really receives, not a contrivance. */
const bothAtOnce = (first: Patch[], second: Patch[]): StreamPart[] => [
  ...editApp(first, "call_a").slice(0, -1),
  ...editApp(second, "call_b"),
];

describe("the loadout (§4.2 — assembly tools only)", () => {
  it("equips the assembly verbs and the host's READ tools, and nothing else", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    // EXACTLY these four, hands included — a mutating host tool (`maple_pay`), the
    // front door that called this loop (`vendo_make`) and every `read`-graded
    // platform verb are all absent, and a closed list is a claim about what is
    // absent. This is a FRESH build, which is the whole of what it may carry.
    expect(new Set(screen.model.toolNamesPerCall[0] ?? []))
      .toEqual(new Set(["ask_user", "maple_spend_summary", SAVE_APP_TOOL, EDIT_APP_TOOL]));
  });

  it("a FRESH build has no app to open, and is offered neither verb nor button for one", async () => {
    // The loadout follows the task: this run's app is the file it has not written
    // yet, so opening it or listing its saved records can only answer `not-found` —
    // a step off a ten-step budget. Both are graded `read`, which is exactly how
    // they rode in.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).not.toContain("vendo_apps_open");
    expect(offered).not.toContain("vendo_apps_data_list");
    // …and they do not come back as a BUTTON. Refusing to equip a verb drops it
    // into the brief's complement, so a withholding that covered one half would
    // teach the model to wire the very tool it was not given.
    expect(screen.model.systemPrompts[0] ?? "").not.toContain("vendo_apps_");
  });

  it("an EDIT gets both back — the document already at this app's path is the distinction", async () => {
    // No mode flag exists and none is wanted: the app to open is the file the loop
    // is about to rewrite, and its presence is what the run reads.
    const screen = harness({
      existing: TWO_TEXT_APP,
      turns: [sayAndEdit("Renamed it.", [{ find: '"Last month"', replace: '"July"' }])],
    });
    const result = await screen.assemble("call it July");

    expect(result.kind).toBe("assembled");
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    expect(offered).toContain("vendo_apps_open");
    expect(offered).toContain("vendo_apps_data_list");
  });

  it("offers no `vendo_slots_list` in either mode — where a view GOES is the caller's question", async () => {
    // Machinery riding in on a `read` grade, exactly as `validate` did: a writer
    // handed the slot registry is a writer handed the workshop.
    for (const existing of [undefined, TWO_TEXT_APP]) {
      const screen = harness({
        turns: [saveApp(GOOD_APP), textTurn("done")],
        ...(existing === undefined ? {} : { existing }),
      });
      await screen.assemble("show me my spending");
      expect(screen.model.toolNamesPerCall[0] ?? []).not.toContain("vendo_slots_list");
      // …and not a button either (`NEVER_WIRED`), for the same reason `validate` is
      // not one.
      expect(screen.model.systemPrompts[0] ?? "").not.toContain("vendo_slots_list");
    }
  });

  it("carries no door out — no `escalate` hand, and the environment note names none", async () => {
    // A tool the model is never handed is a tool it cannot reach for, so the hand
    // is gone and so is the bullet that taught it. The shipped manual's own hedged
    // sentence ("where you have that tool") is the only place the word survives,
    // and it is hedged for exactly this — so the claim is about the environment
    // note, which is this loop's own instructions, and not the whole brief.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    expect(screen.model.toolNamesPerCall[0] ?? []).not.toContain("escalate");
    const note = (screen.model.systemPrompts[0] ?? "").split("\n\n---\n\n").at(-1) ?? "";
    expect(note).toContain("# In this loop");
    expect(note).not.toContain("escalate");
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

  it("offers no hiring and no discovery — a closed list is total", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const offered = screen.model.toolNamesPerCall[0] ?? [];
    // `vendo()`'s own two additions to any loadout. A fixed menu has nothing to
    // discover, and a cheap first pass does not staff a build.
    expect(offered).not.toContain("hire_subagent");
    expect(offered).not.toContain("find_tools");
  });

  it("writes out what a tool the screen can WIRE must be SENT, and never one it can CALL", async () => {
    // The brief's tool section is the loadout's COMPLEMENT: an equipped tool
    // already arrives with its own description and its own JSON Schema, so
    // restating it would be the same tool twice in one prompt. What is left over is
    // the write side — the tools this loop may never call but an `onClick` may name
    // — and its INPUT exists nowhere else the model can read.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const system = screen.model.systemPrompts[0] ?? "";
    // The wireable half, with the argument names a handler needs and no way to
    // learn.
    expect(system).toContain("wire_probe_cents");
    expect(system).toContain("maple_pay — Send money");
    // …and NOT its response shape: the briefing pack's own `TOOL RESPONSE SHAPES`
    // card carries every tool's, this one included, so a `returns:` JSON here was
    // the same bytes twice in one prompt.
    expect(system).not.toContain("wire_return_probe");
    expect(system).not.toContain("returns:");
    expect(system).toContain("What each one RETURNS is in TOOL RESPONSE SHAPES above");
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
    // The run says so itself, in the floor's own words. It used to answer
    // `assembled` and leave the front door to notice there was no ROW — which held
    // only while the refused save was also the run's first.
    expect(result).toEqual({
      kind: "unavailable",
      why: expect.stringContaining("does not compile as TSX"),
    });
  });

  /** No row YET is not a failure, so a memory door answering `not-found` is an
   *  info line, not a warning that sends an operator hunting for a broken store.
   *  The check read `instanceof VendoError`, and a host bundle's second
   *  `@vendoai/core` copy mints a different class — so the field kept firing the
   *  warning it was told it had stopped firing. */
  it("demotes a not-found from ANOTHER realm's VendoError, exactly like its own", async () => {
    const logs: VendoLogEvent[] = [];
    setLogger((event) => { logs.push(event); });
    const screen = harness({
      turns: [
        toolCallTurn(SAVE_APP_TOOL, { content: GOOD_APP, decisions: "Totals are the host's." }),
        textTurn("done"),
      ],
      remember: async () => {
        throw Object.assign(new Error("app not found: app_screen"), {
          name: "VendoError",
          code: "not-found",
        });
      },
    });
    await screen.assemble("show me my spending");

    const codes = logs.map((event) => event.code);
    expect(codes).not.toContain("vendo.screen-agent-decisions-not-recorded");
    expect(codes).toContain("vendo.screen-agent-decisions-no-row");
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
    // What it carries is the FLOOR's own refusal — the gauntlet's own findings,
    // relayed verbatim — never a verdict from a gate that never ran.
    const note = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(note).toContain("does not compile as TSX");
    expect(note).not.toContain("validate found nothing to fix");
    expect(note).not.toContain("That save landed.");
  });

  it("refuses a save that did not paint with the floor's findings and a PATCH-ONLY hand", async () => {
    // The floor's own sentences travel — the FINDINGS, with the hand that fixes
    // them named under them, and no word of the builder gate's own header.
    // "Fix each of these, then
    // write the file again" (`repairInstruction`) sat directly above the line that
    // forbids exactly that, and the model obeyed the sentence it read first: a whole
    // document re-emitted per refusal, which is what the 174-second tails were made
    // of.
    const screen = harness({ turns: [saveApp(BROKEN_APP), textTurn("done")] });
    await screen.assemble("show me my spending");
    const note = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(note).toContain("does not compile as TSX");
    expect(note).toContain("edit_app");
    expect(note).toContain("Never save the whole document");
    expect(note).not.toContain("write the file again");
    expect(note).not.toContain("does not pass on the screen");
  });

  it("a commit that did not land is told to the model, not swallowed", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], conflict: true });
    const result = await screen.assemble("show me my spending");
    expect(screen.emitted).toHaveLength(0);
    expect(result.kind).toBe("unavailable");
  });
});

/**
 * "assembly produced nothing that renders" was the answer to THREE different
 * questions — a run that never saved, a deployment with no screen engine, and a
 * screen that compiled but could not be described — and the sentence naming which
 * one existed only on the operator's console. A person reading the chat learned
 * nothing they could act on, and the run above them reported `failed` over a
 * screen that was, in the ported case, sitting there painted.
 */
describe("what a run that painted nothing actually says", () => {
  it("names the run that never saved a screen, rather than blaming the assembly", async () => {
    // The model talks and never writes. Nothing landed, so there is no paint to
    // explain — but "produced nothing that renders" describes a screen that
    // failed, and no screen was ever written.
    const screen = harness({ turns: [textTurn("I had a think about it")] });
    const result = await screen.assemble("show me my spending");

    expect(screen.workspace.commits).toHaveLength(0);
    expect(result.kind).toBe("unavailable");
    expect(result.why).toContain("never saved a screen");
    expect(result.why).not.toContain("produced nothing that renders");
  });

  it("names the DEPLOYMENT when no screen engine is wired, in words an operator can act on", async () => {
    // The save is good and its bytes land. There is simply no door to paint
    // through, which no rewrite of the screen can fix — so the run must say that
    // rather than send the model back to repair a screen that was never the
    // problem.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], screenEngine: false });
    const result = await screen.assemble("show me my spending");

    expect(screen.workspace.commits).toHaveLength(1);
    expect(screen.emitted).toHaveLength(0);
    expect(result.kind).toBe("unavailable");
    expect(result.why).toContain("screen engine");
    expect(result.why).not.toContain("produced nothing that renders");
  });

  it("still prefers the floor's own words when the floor is the one that refused", async () => {
    // The seam's reason is a FALLBACK for the exits where the floor never spoke.
    // A floor that did speak keeps the sentence, because it is the one that names
    // what to fix in the screen.
    const screen = harness({ turns: [saveApp(BROKEN_APP), textTurn("done")] });
    const result = await screen.assemble("show me my spending");

    expect(result.why).toContain("does not compile as TSX");
  });
});

describe("the edit hand (every edit in one call, all of them or none)", () => {
  const APP_PATH = `/user/apps/${APP}/${SCREEN_FILE}`;

  it("applies every edit in the call against the file as it stands, in ONE landing", async () => {
    const screen = harness({
      turns: [
        saveApp(TWO_TEXT_APP),
        editApp([
          { find: '"This month"', replace: '"August"' },
          { find: '"Last month"', replace: '"July"' },
        ]),
        textTurn("done"),
      ],
    });
    await screen.assemble("show me my spending");

    const saved = await screen.workspace.readFile(APP_PATH);
    expect(saved).toContain('text="August"');
    expect(saved).toContain('text="July"');
    // One commit for the batch, so the person's screen repaints once rather than
    // once per finding — and the second quote was written against the same bytes
    // the first one was, which is the whole reason a batch is matched before any
    // of it is spliced.
    expect(screen.workspace.commits).toHaveLength(2);
  });

  it("names the edit that missed and changes NOTHING — not even the edits that matched", async () => {
    const screen = harness({
      turns: [
        saveApp(TWO_TEXT_APP),
        editApp([
          { find: '"This month"', replace: '"August"' },
          { find: '<Text text="Next month" />', replace: '<Text text="September" />' },
        ]),
        textTurn("done"),
      ],
    });
    await screen.assemble("show me my spending");

    // Untouched, and not even a commit: a half-applied batch would leave the model
    // holding a document that no longer exists.
    expect(await screen.workspace.readFile(APP_PATH)).toBe(TWO_TEXT_APP);
    expect(screen.workspace.commits).toHaveLength(1);
    // The refusal says WHICH edit — a model holding several cannot re-quote the
    // right one otherwise — and echoes the file's real text at the divergence.
    const note = JSON.stringify(screen.model.prompts[2] ?? "");
    expect(note).toContain("Edit 2 of 2");
    expect(note).toContain("Next month");
    expect(note).toContain("NOTHING was changed");
    expect(note).toContain("part company after");
  });

  /**
   * The clobber, closed. Two edit calls in one step both read the file, both
   * splice their own change into the bytes they read, and the second commit wins
   * — so one of the two edits is silently gone while BOTH hands answer "That save
   * landed" and the model has no way to tell from its own transcript.
   */
  it("lands two edits sent in the same step — the second does not throw the first away", async () => {
    const screen = harness({
      turns: [
        saveApp(TWO_TEXT_APP),
        bothAtOnce(
          [{ find: '"This month"', replace: '"August"' }],
          [{ find: '"Last month"', replace: '"July"' }],
        ),
        textTurn("done"),
      ],
    });
    await screen.assemble("show me my spending");

    const saved = await screen.workspace.readFile(APP_PATH);
    expect(saved).toContain('text="August"');
    expect(saved).toContain('text="July"');
    expect(screen.workspace.commits).toHaveLength(3);
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

  it("tells the repair round the budget it actually has, and leaves the brief untouched", async () => {
    // Two facts, and the second is why the first moved. The repair round's budget
    // is REPAIR_STEPS — it once said SCREEN_STEPS on both drives, so a model given
    // three steps was planning for ten. And the number now rides BEHIND the
    // history: it used to be interpolated into the brief, which is the turn's
    // cached prefix, so every repair round re-uploaded some sixteen thousand
    // tokens to say `3` where it had said `10`.
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("fixed")],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");

    expect(JSON.stringify(screen.model.prompts[0] ?? "")).toContain(`\`${SCREEN_STEPS}\` steps`);
    const repair = JSON.stringify(screen.model.prompts[2] ?? "");
    expect(repair).toContain(`\`${REPAIR_STEPS}\` steps`);
    expect(repair).not.toContain(`\`${SCREEN_STEPS}\` steps`);
    // Two budgets, one prefix: the brief is the same bytes on both drives.
    expect(screen.model.systemPrompts[2]).toBe(screen.model.systemPrompts[0]);
  });

  /** The reviewer used to queue BEHIND the closing words: it started only once the
   *  whole drive had finished, so its model call waited on a turn that was writing
   *  a sentence. It starts at the paint it judges now — same reviewer, same one
   *  call, same repair round; only the moment it is asked has moved. */
  it("is asked at the paint, not after the words — and its verdict is still acted on", async () => {
    const screen = harness({
      turns: [sayAndSave("Spending is on screen.", GOOD_APP), textTurn("fixed")],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");

    // Two calls: the save-and-say turn, then the repair round. No turn in between
    // for the reviewer to have waited on.
    expect(screen.model.calls).toBe(2);
    expect(screen.invocations["validate"]).toBe(1);
    expect(JSON.stringify(screen.model.prompts[1] ?? "")).toContain(FINDING);
  });

  /** The reviewer judges "sections that don't answer the ask" and "work quietly
   *  dropped" against the person's own words, and the verb had no field to carry
   *  them — so this gate asked for a judgement on an ask it never handed over, and
   *  those two rules were dead text on every screen it ever judged. */
  it("hands the reviewer the person's ask, verbatim", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending by month");

    expect(screen.toolArgs["validate"]).toEqual([{ appId: APP, request: "show me my spending by month" }]);
  });

  /** `ok` is "no blocker", and the ask rules and the host's own design rules are
   *  graded `warn` for a person's eye — so a gate reading the verdict instead of
   *  the findings spent the reviewer's model call and then changed nothing. */
  it("repairs on a WARN too, in exactly one round", async () => {
    const screen = harness({
      turns: [
        saveApp(GOOD_APP),
        textTurn("done"),
        // More turns than one repair round can spend, so a second round would show
        // up as extra calls.
        ...Array.from({ length: REPAIR_STEPS + 2 }, () => saveApp(GOOD_APP)),
      ],
      answers: {
        validate: { ok: true, findings: [{ severity: "warn", message: "the ask named a monthly total; nothing on screen shows one" }] },
      },
    });
    await screen.assemble("show me my spending by month");

    // ONE judging call, and ONE repair round on top of the two turns that built
    // the screen — never a second pass over the same verdict.
    expect(screen.invocations["validate"]).toBe(1);
    expect(screen.model.calls).toBe(2 + REPAIR_STEPS);
    expect(JSON.stringify(screen.model.prompts[2] ?? "")).toContain("nothing on screen shows one");
  });

  /**
   * THE VERDICT RIDES THE SAVE. The reviewer used to answer after the drive was
   * already over: the closing save hung the loop up, the verdict was awaited, and
   * a SECOND drive was spun that had to be handed the document back. Same one
   * call and same one round now — but the findings come back inside the save's own
   * tool result, so the fix is the next step of the drive that wrote the screen,
   * with the document still in front of it.
   */
  it("hands the reviewer's findings back inside the closing save, and the fix lands on the next step", async () => {
    const screen = harness({
      turns: [
        sayAndSave("Spending is on screen.", TWO_TEXT_APP),
        editApp([{ find: '"This month"', replace: '"August"' }]),
        textTurn("fixed"),
      ],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");

    // The findings are part of the save's own answer — the message the model
    // reads before its very next step.
    const answer = JSON.stringify(screen.model.prompts[1] ?? "");
    expect(answer).toContain("That save landed");
    expect(answer).toContain(FINDING);
    // …and nothing spun a second drive to carry them: no round in this run was
    // ever handed the document back, because it never left the model's hands.
    expect(JSON.stringify(screen.model.prompts)).not.toContain("This is the document you saved");
    // The patch reached the screen the person is already looking at.
    expect(await screen.workspace.readFile(`/user/apps/${APP}/${SCREEN_FILE}`)).toContain('text="August"');
    expect(screen.invocations["validate"]).toBe(1);
    expect(screen.model.calls).toBe(3);
  });

  it("judges ONCE, even when the repair patch speaks beside its own save", async () => {
    // The repair is itself a save that paints and speaks, which is exactly the
    // shape that summons the reviewer — so nothing but the run's own one-verdict
    // flag stops a screen from being judged, repaired, judged, repaired.
    const screen = harness({
      turns: [
        sayAndSave("Spending is on screen.", TWO_TEXT_APP),
        sayAndEdit("Fixed the total.", [{ find: '"This month"', replace: '"August"' }]),
        ...Array.from({ length: REPAIR_STEPS + 2 }, () => saveApp(TWO_TEXT_APP)),
      ],
      answers: findsSomething,
    });
    await screen.assemble("show me my spending");

    expect(screen.invocations["validate"]).toBe(1);
    // Two calls: the save that built it and the patch that fixed it. The patch
    // hung up in its own turn, exactly as the first save would have on a clean
    // verdict.
    expect(screen.model.calls).toBe(2);
  });

  it("hangs up on a clean verdict, exactly as it always did", async () => {
    const screen = harness({
      turns: [sayAndSave("Spending is on screen.", GOOD_APP), textTurn("never asked for")],
      answers: { validate: { ok: true, findings: [] } },
    });
    const result = await screen.assemble("show me my spending");

    expect(result.say).toBe("Spending is on screen.");
    expect(screen.invocations["validate"]).toBe(1);
    // ONE call. Nothing to fix is no round, and no turn is spent saying so.
    expect(screen.model.calls).toBe(1);
  });

  it("stays silent on an EMPTY verdict, exactly as it always did", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("never asked for")],
      answers: { validate: { ok: true, findings: [] } },
    });
    await screen.assemble("show me my spending");

    // Two calls: the save and the closing words. Nothing to fix is no round.
    expect(screen.model.calls).toBe(2);
  });

  it("names every finding verbatim, with the document it must fix and the hand that fixes it", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("fixed")],
      answers: {
        validate: {
          ok: false,
          findings: [
            { severity: "block", message: FINDING },
            { severity: "warn", where: "line 3", message: "the ask named a monthly total; nothing shows one" },
          ],
        },
      },
    });
    await screen.assemble("show me my spending");
    // The repair round's own first call — the drive after the review pass.
    const repair = JSON.stringify(screen.model.prompts[2] ?? "");
    // Each finding, with its own locus: the reviewer's sentences are written to be
    // repaired from, so they are the whole of what this round is told.
    expect(repair).toContain(FINDING);
    expect(repair).toContain("line 3 the ask named a monthly total");
    expect(repair).toContain("This is the document you saved");
    // …and the same treatment the save's own refusal gets, for the same reason: the
    // patch hand, and none of the builder gate's "write the file again" above it.
    expect(repair).toContain("edit_app");
    expect(repair).toContain("Never save the whole document");
    expect(repair).not.toContain("write the file again");
    expect(repair).not.toContain("does not pass on the screen");
  });
});

describe("the closing words ride the last save", () => {
  /** Two model calls used to end every run that could have ended in one: the save,
   *  then a turn whose only job was to say what had just been saved. A provider
   *  can send prose and a tool call in the same message, so it does. */
  it("takes the receipt from the save's own turn, and asks for no turn after it", async () => {
    const screen = harness({ turns: [sayAndSave("Your ledger is up, with all 3 rows.", GOOD_APP)] });
    const result = await screen.assemble("show me my spending");

    expect(result.kind).toBe("assembled");
    expect(result.say).toBe("Your ledger is up, with all 3 rows.");
    // The whole point: ONE call. The scripted model has no second turn, and the run
    // never asks for one.
    expect(screen.model.calls).toBe(1);
    expect(screen.emitted.map((part) => part.payload.streaming)).toEqual([false]);
  });

  it("still takes the words a run spoke on its own, when it spoke after acting", async () => {
    // The merge is an instruction, not a requirement: a model that saves and then
    // speaks is the run this loop has always had, and its receipt is unchanged.
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("Spending is on screen.")] });
    const result = await screen.assemble("show me my spending");
    expect(result.say).toBe("Spending is on screen.");
    expect(screen.model.calls).toBe(2);
  });
});

describe("what each turn thinks with", () => {
  /**
   * The screen is designed in ONE turn — step 0, where the whole document is
   * written — and everything after it is a save, a patch, or the sentence about
   * one. The provider's knob for that is `output_config.effort` (a thinking
   * budget is a 400 on the models this runs on), and the loop's own per-step hook
   * carries no provider options, so the seat itself is where it has to live.
   */
  it("leaves the write turn as configured and asks for LOW effort on every turn after it", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")] });
    await screen.assemble("show me my spending");

    // Nothing of this file's is on the write turn: a default it did not choose is
    // the only honest "think as hard as you need to".
    expect(screen.model.providerOptionsPerCall[0]?.["anthropic"]).toBeUndefined();
    expect(screen.model.providerOptionsPerCall[1]?.["anthropic"]).toEqual({ effort: "low" });
  });

  it("spends the write turn once per run, so a repair round is all patch", async () => {
    const screen = harness({
      turns: [saveApp(GOOD_APP), textTurn("done"), textTurn("fixed")],
      answers: { validate: { ok: false, findings: [{ severity: "block", message: "the total is wrong" }] } },
    });
    await screen.assemble("show me my spending");

    // The repair drive starts a new turn, not a new run: it is a patch round from
    // its first step, and the seat is already spent.
    expect(screen.model.providerOptionsPerCall[2]?.["anthropic"]).toEqual({ effort: "low" });
  });

  /**
   * Which spec version a live model reports is the AI SDK major the host
   * installed — an ai@6-era provider says "v3", an ai@7-era one says "v4" — and a
   * seat that admitted only v3 handed every ai@7 host its model back UNWRAPPED:
   * no middleware, so every save and patch after the write turn kept thinking at
   * full price, silently and on every run.
   */
  it("seats the v4 model an ai@7 host resolves the same way, so its patches are cheap too", async () => {
    const screen = harness({ turns: [saveApp(GOOD_APP), textTurn("done")], spec: "v4" });
    const result = await screen.assemble("show me my spending");

    // Wrapped, and still driveable through it: a middleware that broke the seat
    // would cost the whole screen rather than the effort.
    expect(result.kind).toBe("assembled");
    expect(screen.model.providerOptionsPerCall[0]?.["anthropic"]).toBeUndefined();
    expect(screen.model.providerOptionsPerCall[1]?.["anthropic"]).toEqual({ effort: "low" });
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
