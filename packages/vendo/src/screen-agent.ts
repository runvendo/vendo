/**
 * The screen agent — UI-generation blueprint §4.2 and §4.5.
 *
 * It is `vendo()` with a CLOSED loadout and a tight step budget, not a harness of
 * its own: the assembly verbs and the host's read tools by name, two hands of its
 * own, and one door out. There is no second drive of `startTurn` here — the step
 * cap, the seat resolution, `wireErrorMessage`, the history knobs and the system
 * precedence are the default harness's, so a rail cannot be fixed in one loop and
 * stay broken in the other. What this file holds is the CONFIGURATION: the brief,
 * the loadout, the two hands, and the outcome the front door reads.
 *
 * - **The write path is `turn.workspace`.** The `claudeCode()` harness already
 *   builds apps this way: the model writes `plan.vendo` / `app.vendo` with its own
 *   hands and the runtime's commit is what makes it real
 *   (`claude-code/index.ts:338`, `skills/building-apps.ts:68`). This agent has no
 *   disk and no shell, so the two files it may write are two hands over the same
 *   `WorkspaceFs`. There is no third writer.
 * - **The paint path is the render seam.** `wrapWorkspaceForRender` intercepts
 *   `commit()`, compiles, and emits `data-vendo-view`. This file never emits a
 *   view and never compiles anything — that is exactly why a screen it assembles
 *   passes the same floor a `claudeCode()` app does.
 * - **`vendo_make` is withheld, not merely unused.** The screen agent IS what
 *   `vendo_make` calls, so leaving it callable is a loop. The closed loadout
 *   excludes it by omission.
 * - **The job description is the shipped skill.** `buildingAppsSkill` plus its
 *   `references/format.md` are the same text `claudeCode()` reads. This file adds
 *   one short block that corrects the ENVIRONMENT (no disk, no delegation, two
 *   files, one door out) rather than restating the job — a third prompt is the
 *   thing §0 forbids.
 *
 * Screens run UNSANDBOXED, by §6.5: a description is data, its props are
 * schema-validated, and the kit treats them as inert. There is no box here.
 */
import {
  VENDO_MAKE_TOOL,
  mintTurnId,
  type AppId,
  type CommitResult,
  type SeatModels,
  type RunContext,
  type ToolListing,
  type ToolRegistry,
  type TurnId,
  type TurnSkills,
  type TurnState,
  type TurnTools,
  type WorkspaceFs,
  type Turn,
  inputSchemaIsBlind,
  modelToolDescription,
  UNKNOWN_INPUT_SCHEMA_NOTE,
  UNKNOWN_OUTPUT_SHAPE_NOTE,
} from "@vendoai/core";
import {
  type ScreenAssembler,
  type ScreenOutcome,
  type ScreenRequest,
} from "@vendoai/apps/contract";
import {
  buildingAppsSkill,
  paintedIn,
  repairInstruction,
  validateWrittenApps,
  wrapWorkspaceForRender,
  type RenderSeamOptions,
} from "@vendoai/apps";
import type { LanguageModel } from "ai";
import { vendo, type HarnessHand, type VendoHarnessOptions } from "@vendoai/harnesses";

/**
 * The whole budget for assembling one screen.
 *
 * Sized off the work, not off a round number: learn a shape or search the
 * catalog (1–2), save the app (1–3, because saving as you go is what makes it
 * grow on screen), `validate` and fix what it reports (2–3), and one step to
 * speak. `instant()`'s `ACT_STEPS = 2` is a specialist that must not think;
 * `DEFAULT_MAX_STEPS = 20` is a resident that may. A screen is neither, and the
 * cap is the definition of "cheap": an ask that needs more than this is an ask
 * for a BUILD, and `escalate` is the honest exit rather than a bigger number.
 */
export const SCREEN_STEPS = 10;

/** The one door out of assembly (§4.5). Never `vendo_`-prefixed: the loadout's
 *  `isAlwaysActive` would make it un-gateable, and this tool is the screen
 *  agent's own, not a product capability anybody else may reach. */
export const ESCALATE_TOOL = "escalate";

/** The file hands. Two files, so two tools and no path argument — a screen agent
 *  has exactly one app directory, and a tool that takes a path is a tool that can
 *  write outside it. */
export const SAVE_APP_TOOL = "save_app";

/**
 * The assembly verbs, by NAME rather than by risk.
 *
 * `validate` and `search_components` are graded `write` on purpose — design §12's
 * mechanical vote fail-closes a name ending in a noun (`vendo-verbs.ts:41-48`) —
 * so a `risk === "read"` filter would drop the two tools the whole loop is built
 * around. Host read tools come in by risk below; these come in by name.
 */
const ASSEMBLY_TOOLS: readonly string[] = [
  "search_components",
  "validate",
  "vendo_apps_data_list",
  "vendo_apps_open",
  "ask_user",
];

/**
 * What the lean loop needs, and nothing else.
 *
 * A structural subset of `Turn`, so a caller already inside a turn passes its own
 * turn verbatim — no adapter, no wrapper — and the `vendo_make` door builds the
 * same fields out of the pieces composition already holds. The two identities are
 * optional because only a caller inside a turn already has them.
 */
export interface ScreenSurface {
  readonly models: SeatModels<LanguageModel>;
  readonly tools: TurnTools;
  /** Wrapped by the render seam before it gets here, so `commit()` paints. */
  readonly workspace: WorkspaceFs;
  readonly signal: AbortSignal;
  readonly threadId?: string;
  readonly turnId?: TurnId;
}

export interface ScreenInput {
  /** The app whose files this run writes. Minted by the caller so the file path,
   *  the view's stream id and any receipt all name the same app. */
  appId: AppId;
  /** The person's ask, verbatim. */
  request: string;
  /** The deployment's assembled prompt, when there is one — prepended, so the
   *  host's voice and the guard's directions are not lost to the job description. */
  system?: string;
  /** The host's own theme tokens and design rules (`hostDesignBrief`), when
   *  composition has them. House rules for the WRITER, so they sit with the job
   *  description rather than with the deployment's voice. */
  design?: string;
}

/** What one assembly run answers. `ScreenOutcome` plus the title an assembled
 *  screen named itself, which the front door turns into a receipt. */
export type ScreenResult = ScreenOutcome & {
  title?: string;
  /** What the run chose to record for the next editor (`save_app`'s
   *  `decisions`). Never a summary this file wrote — only the agent's own words,
   *  or nothing. */
  decisions?: string;
};

const APP_FILE = "app.vendo";
const PLAN_FILE = "plan.vendo";

/** §3.1's frozen layout, personal mount. A NEW app is always `/user/**`: a fresh
 *  `/orgs/<org>/apps/<id>/` path has no row to grant on, so the workspace façade
 *  refuses the commit and the file never lands (see `AppsRuntime.authored`). */
const appDirectory = (appId: AppId): string => `/user/apps/${appId}`;

/**
 * Where an escalating run left its plan (§4.5).
 *
 * Exported because the RECEIVING end has to read it back — the build anchors on
 * the plan the person is already looking at — and the one thing worse than a
 * missing brief is two files spelling the same path. This file owns the
 * convention; composition just asks it where.
 */
export const escalatedPlanPath = (appId: AppId): string => `${appDirectory(appId)}/${PLAN_FILE}`;

/** The app's own name, off the document it just wrote. Presentation only — the
 *  receipt's `title` — so a file that has not named itself yet is simply absent
 *  rather than a reason to fail. */
const nameOf = (content: string): string | undefined => {
  const match = /<App\b[^>]*\bname="([^"]+)"/.exec(content);
  return match?.[1]?.trim() || undefined;
};

/**
 * The host's surface, as the model reads it before writing a single binding.
 *
 * `ToolListing.outputSchema` is the host's OWN declared result shape, captured by
 * extraction and threaded onto the listing precisely so "the model reads field
 * names off the listing instead of calling a query once to learn them"
 * (`turn-tools.ts:236-253`).
 *
 * EVERY tool gets both lines. A slot nothing could read prints its unknown
 * sentence rather than nothing (outputs) or a bare `{}` (inputs): `{}` reads as
 * "takes no arguments", so a blind tool would be called with none. A DECLARED
 * empty input still prints its schema — that IS the host's contract.
 */
export function toolBrief(listings: readonly ToolListing[]): string {
  if (listings.length === 0) return "This product has no tools you can read data from.";
  return listings
    .map((listing) => {
      const shape = listing.outputSchema === undefined
        ? `\n  ${UNKNOWN_OUTPUT_SHAPE_NOTE}`
        : `\n  returns: ${JSON.stringify(listing.outputSchema)}`;
      const input = inputSchemaIsBlind(listing.inputSchema)
        ? `\n  ${UNKNOWN_INPUT_SCHEMA_NOTE}`
        : `\n  input: ${JSON.stringify(listing.inputSchema)}`;
      return `- ${listing.name} — ${modelToolDescription(listing)}${input}${shape}`;
    })
    .join("\n");
}

/**
 * The environment correction, and only that.
 *
 * The shipped skill is written for a reader with a machine: a `Task` tool, a
 * `host/components/` directory, a `references/format.md` on disk, "edit the text
 * in place". None of those exist here. So these lines say what is different and
 * the skill says what the job is — which is the difference between deriving a
 * brief and forking one.
 */
const environmentNote = (appId: AppId, listings: readonly ToolListing[]): string => `# In this loop

You have no machine: no shell, no \`Task\`, no files on disk. Everything the skill
above tells you to read is already below, and everything it tells you to write goes
through two tools.

- **\`${SAVE_APP_TOOL}\`** saves this app's whole document. The app is
  \`${appId}\`; you never name a path. Every save that parses repaints the person's
  screen, so save as you go — a save is cheap and silence is not. There is no
  edit-in-place tool: save the full document each time.
  Its \`decisions\` is this app's MEMORY, and the only thing the next editor will
  have besides the document. Record what reading the document could not tell
  them — why you narrowed something, a constraint the tools imposed, a shape you
  ruled out. Never record what you did or in what order; that is narration, and
  it crowds out the one line that mattered.
- **\`validate\`** is the floor. Call it on what you saved, fix what it names, save
  again. You are not done until it comes back clean.
- **\`${ESCALATE_TOOL}\`** is the one door out. Assembling a document out of this
  product's components is all you can do; anything that needs real code, its own
  server, a file the person uploads, or a surface these components cannot express
  goes through it. Write the plan when you escalate — that plan becomes the first
  thing the person sees while the builder works, AND it is the builder's whole
  brief. Nothing re-plans it, so say which lane the work runs in with the
  \`<Server kind="steps"|"agentic"|"box" [served] why="…"/>\` line the skill above
  teaches. Leave it out and the builder reads the escalation itself as the answer:
  \`kind="box"\`, a machine and real code.
- \`${SCREEN_STEPS}\` steps is the whole budget. Escalate rather than run out of it.

Never look for a tool that builds the app for you. There isn't one, and that is
deliberate.

## This product's tools, with the shapes they return

${toolBrief(listings)}`;

/** The full brief: the deployment's own prompt, the shipped job description, the
 *  shipped syntax manual, the host's own house rules, then what is different
 *  here. The design brief sits with the job rather than with the deployment's
 *  voice — it is configuration the writer obeys, not a thing to say. */
function screenBrief(input: ScreenInput, listings: readonly ToolListing[]): string {
  return [
    input.system,
    buildingAppsSkill.body,
    buildingAppsSkill.files?.[`references/${"format.md"}`],
    input.design,
    environmentNote(input.appId, listings),
  ]
    .filter((section): section is string => section !== undefined && section.trim().length > 0)
    .join("\n\n---\n\n");
}

/** What the two hands recorded, for THIS run. A collector on the run rather than
 *  module state: the hands are built per run and closed over it, so two concurrent
 *  assemblies cannot read each other's verdict. */
interface RunRecord {
  /** Did an `app.vendo` save ever reach the store? */
  assembled: boolean;
  /** Did the LAST save reach the person's SCREEN? A landed save is not a finished
   *  screen — bytes the seam declines to paint leave a row-less app the hand
   *  already sent back to the floor — and only a finished screen faces the
   *  reviewer. Absent paint information (an unwrapped workspace) claims nothing,
   *  exactly as the hand's own gate does. */
  painted: boolean;
  title?: string;
  escalated?: string;
  /** The last non-empty `decisions` a save carried — this run's whole memory
   *  contribution, and what replaces the app's stored block. */
  decisions?: string;
}

/** Nothing to hire and nothing to load: the job description is already the whole
 *  brief, and `hire_subagent` is not on this loadout. */
const NO_SKILLS: TurnSkills = {
  async list() {
    return [];
  },
  async load(name: string) {
    throw new Error(`the screen agent carries no skills, so it cannot load ${name}`);
  },
};

const runState = (): TurnState => {
  let value: string | undefined;
  return {
    get: () => value,
    set: (next: string) => {
      value = next;
    },
    clear: () => {
      value = undefined;
    },
  };
};

/**
 * ONE assembly run, over any surface a `Turn` satisfies.
 *
 * Every host effect goes through `surface.tools.call()` and every file write
 * through `surface.workspace`, so the guard, the audit row, the approval card and
 * the paint seam are not this function's business and cannot be forgotten.
 */
export async function assembleScreen(
  surface: ScreenSurface,
  input: ScreenInput,
): Promise<ScreenResult> {
  if (surface.signal.aborted) return { kind: "unavailable", why: "the caller hung up" };

  // Seats are required only where a harness reads them (contract §4, relaxed) —
  // and the screen agent thinks with `default`, so a turn without it is the
  // caller's composition bug, named loudly rather than limped past. Same posture
  // as `vendo()`, which reads the same seat.
  if (surface.models.default === undefined) {
    throw new Error("the screen agent thinks with `turn.models.default`, and this turn carries no default seat");
  }

  const directory = appDirectory(input.appId);
  const listings = await surface.tools.list().catch(() => [] as ToolListing[]);
  const record: RunRecord = { assembled: false, painted: false };

  /**
   * Write one hot-path file and land it.
   *
   * The commit IS the store write and the paint (§1.6), and the seam answers BOTH
   * questions on the way out: did the write land (`CommitResult.status`), and did
   * it reach the screen (`paintedIn`). The paint verdict is the one this loop
   * could not see before — `emit` belongs to whoever wrapped the workspace, not to
   * us — and it is what separates "saved" from "saved and shown".
   */
  const save = async (turn: Turn<unknown>, file: string, content: string): Promise<CommitResult> => {
    await turn.workspace.writeFile(`${directory}/${file}`, content);
    return await turn.workspace.commit({ message: `${file} (${input.appId})` });
  };

  const saveApp: HarnessHand = {
    name: SAVE_APP_TOOL,
    description:
      "Save this app's whole document. The person's screen repaints on every save that parses, so save "
      + "as you go rather than once at the end. Returns whether the save landed.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The complete app document, in the .vendo format." },
        decisions: {
          type: "string",
          description:
            "What the next person to edit this app must know: choices you made, constraints you found, things "
            + "you ruled out. Only what is invisible from the document itself — never a narration of your work. "
            + "It REPLACES this app's decisions, so write the whole block each time, under 5 lines.",
        },
      },
      required: ["content"],
      additionalProperties: false,
    },
    execute: async (args, turn) => {
      const { content, decisions } = args as { content: string; decisions?: string };
      const committed = await save(turn, APP_FILE, content);
      if (committed.status !== "ok") {
        return { saved: false, note: "The save did not land — someone else changed this app. Save again." };
      }
      record.assembled = true;
      record.title = nameOf(content) ?? record.title;
      // The last save that had something to say wins the run. An omitted or blank
      // `decisions` on a later save is "nothing to add", not "forget the earlier
      // one" — a save-as-you-go loop would otherwise erase its own memory on the
      // final validate-fix save.
      if (decisions !== undefined && decisions.trim() !== "") record.decisions = decisions;
      /**
       * A SAVE THAT NEVER REACHED THE SCREEN HEARS WHY — the builder's own gate
       * (`validateWrittenApps`), on the one case this loop had no door for.
       *
       * Live 2026-08-06 ("a dashboard for my upcoming bills"): a save the seam
       * would not paint leaves no ROW — no paint, no `authored` — and
       * `validate({appId})`, the door this hand's own note sends the model to, is
       * row-scoped. It answered "app not found" on exactly the document that
       * needed judging, so the loop heard nothing, saved again, and the screen the
       * person kept was judged by nothing it could hear from. `{ document }` has
       * no such hole, which is the gate's own reason for taking it.
       *
       * Only when the paint did NOT happen: a painted save is already floored (the
       * seam runs the same checks before it emits), so running them again would
       * pay twice and second-guess the seam. `painted` absent means an unwrapped
       * workspace — nothing known, so nothing claimed.
       */
      const painted = paintedIn(committed);
      record.painted = painted?.includes(input.appId) ?? false;
      if (painted !== undefined && !record.painted) {
        const instruction = repairInstruction(await validateWrittenApps({
          tools: turn.tools,
          workspace: turn.workspace,
          paths: [`${directory}/${APP_FILE}`],
        }));
        // No instruction covers BOTH "validate cleared it" and every way the gate
        // could not reach a verdict — a denied call, an unreadable answer, a
        // workspace that closed under it — each of which the gate reports to the
        // operator and returns empty for, its fail-open being deliberate. So this
        // hand cannot say which happened, and claiming the first told the loop its
        // document had been checked when nothing had checked it. The failed paint
        // is the fact this hand does have, and it is enough to act on.
        return {
          saved: true,
          note: instruction ?? "That save landed but did not reach the person's screen. Save a simpler document.",
        };
      }
      return { saved: true, note: "Run validate on it now." };
    },
  };

  const escalate: HarnessHand = {
    name: ESCALATE_TOOL,
    description:
      "Hand this ask to the builder, which has real code, a real machine and no step budget. Use it when "
      + "assembling a document out of this product's components genuinely cannot serve the ask. Write the "
      + "plan: it becomes the skeleton the person watches while the builder fills it in. This ends your turn.",
    inputSchema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The plan document, in the .vendo plan format." },
        why: { type: "string", description: "One plain sentence: what assembly cannot do here." },
      },
      required: ["plan", "why"],
      additionalProperties: false,
    },
    execute: async (args, turn) => {
      const { plan, why } = args as { plan: string; why: string };
      // §4.5: no consent step and no ceremony. The plan lands, its skeleton
      // paints in seconds, and the work proceeds — so the only thing this
      // returns is the fact that it happened.
      const landed = await save(turn, PLAN_FILE, plan);
      record.escalated = why;
      return { handedOver: true, planSaved: landed.status === "ok" };
    },
  };

  // The small loadout, resolved where the listings are: the assembly verbs by
  // name, plus the host's read tools so a query's real values can be learned when
  // a tool declares no shape. `vendo_make` is excluded by name — it is what called
  // this loop — and a mutating host tool is not an assembly tool. Names, not a
  // risk filter passed downward: the closed list stays a list, and the one place
  // that can decide "is this an assembly tool" is the one holding the listing.
  const loadout: Array<string | HarnessHand> = listings
    .filter((listing) => listing.name !== VENDO_MAKE_TOOL)
    .filter((listing) => ASSEMBLY_TOOLS.includes(listing.name) || listing.risk === "read")
    .map((listing) => listing.name);
  loadout.push(saveApp, escalate);

  const turn: Turn<VendoHarnessOptions> = {
    messages: [{ id: `screen_${input.appId}`, role: "user", parts: [{ type: "text", text: input.request }] }],
    // The listings are read ONCE and handed back verbatim: a closed loadout has
    // nothing to discover, so re-reading them mid-run would be a second projection
    // of the same static menu.
    tools: { call: (name, args) => surface.tools.call(name, args), list: async () => listings },
    skills: NO_SKILLS,
    workspace: surface.workspace,
    models: surface.models,
    state: runState(),
    options: {},
    signal: surface.signal,
    // This loop talks to nobody: the front door speaks the receipt, and an
    // approval it cannot show is a denial with a reason (see `registryTools`).
    interactive: false,
    threadId: surface.threadId ?? `screen_${input.appId}`,
    turnId: surface.turnId ?? mintTurnId(),
  };

  /** The first thing that went wrong, in the shipped loop's own words
   *  (`wireErrorMessage`, applied inside `vendo()`). */
  let failure: string | undefined;
  const harness = vendo({
    tools: loadout,
    maxSteps: SCREEN_STEPS,
    // The brief WINS over `turn.system`: it already folds the deployment's prompt
    // in as its first section, so letting the turn's copy through would say it
    // twice.
    system: () => screenBrief(input, listings),
  });
  /**
   * One drive of the loop. The events MUST be drained or nothing runs. Nothing is
   * teed and nothing is buffered: this loop produces no prose for a person — the
   * screen is the answer and the front door speaks the receipt.
   *
   * It takes the messages because the review below needs a SECOND drive, and a
   * repair round that went through different code than the turn would be a second
   * way to drive the same loop (`claude-code/index.ts`'s `round` for the same
   * reason).
   */
  const drive = async (messages: Turn<VendoHarnessOptions>["messages"]): Promise<void> => {
    for await (const event of harness.run({ ...turn, messages })) {
      if (event.type === "error") failure ??= event.message;
    }
  };
  await drive(turn.messages);

  if (surface.signal.aborted) return { kind: "unavailable", why: "the caller hung up" };
  // Escalation wins over a partial paint: the builder is finishing this app, and
  // saying "ready" over a half-assembled document would be the lie §4.5 exists
  // to avoid. `status: "building"` is the honest receipt, and the front door
  // stamps it.
  if (record.escalated !== undefined) return { kind: "escalate", why: record.escalated };
  // A model failure AFTER a screen already painted is not a failed screen.
  if (record.assembled) {
    /**
     * THE MANDATORY REVIEWER PASS — every finished screen faces it, whether or not
     * this loop ever called `validate` itself.
     *
     * Live 2026-08-06 (demo-bank, "a dashboard for my upcoming bills and
     * subscriptions"): the screen summed two overlapping query results into an
     * $11,216 headline over ~$6,276 of real bills. Every mechanical check passed —
     * a double count is not a shape error — and the one check that could have seen
     * it never ran, because it fires only when the writing model volunteers to
     * call `validate({appId})`. So the gate asks, once, at the end.
     *
     * ONE repair round, for the brain's own reason (`claude-code/index.ts`): being
     * shown exactly what is wrong fixes it on the first try or not at all, and a
     * second round is the person waiting longer for the same answer. Whatever
     * survives it stands — the screen has already painted, and the honest thing is
     * to leave it rather than take it away.
     *
     * `record.painted` is the gate, not `record.assembled`. A save that landed bytes
     * the seam declined to paint is not a finished screen: the hand already handed
     * that loop the floor's own sentences, the app has no row for the reviewer's
     * row-scoped door to find, and asking again here would only spend the person's
     * time repeating it.
     */
    const appPath = `${directory}/${APP_FILE}`;
    const instruction = record.painted
      ? repairInstruction(await validateWrittenApps({
        tools: turn.tools,
        workspace: turn.workspace,
        paths: [appPath],
        review: true,
      }))
      : undefined;
    if (instruction !== undefined && !surface.signal.aborted) {
      // The document rides along: a drive starts from the messages it is given, so
      // the repair round has none of the first one's context — and a repair with no
      // document in front of it is a rewrite from scratch.
      const saved = await turn.workspace.readFile(appPath).catch(() => undefined);
      await drive([...turn.messages, {
        id: `repair_${input.appId}`,
        role: "user",
        parts: [{
          type: "text",
          text: saved === undefined
            ? instruction
            : `${instruction}\n\nThis is the document you saved. Save the whole corrected version:\n${saved}`,
        }],
      }]);
    }
    return {
      kind: "assembled",
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.decisions === undefined ? {} : { decisions: record.decisions }),
    };
  }
  return { kind: "unavailable", why: failure ?? "assembly produced nothing that renders" };
}

// ─── The `vendo_make` route ──────────────────────────────────────────────────

export interface ScreenAssemblerDeps {
  /** The seats, as `Turn.models` carries them. */
  models: SeatModels<LanguageModel>;
  /** The GUARD-BOUND registry (`VendoGuard.bind(hostTools)`) — the same choke
   *  point every harness's calls pass through. */
  tools: ToolRegistry;
  /** This principal's workspace, unwrapped. The assembler wraps it with the
   *  render seam itself, so composition never has to know that it must. */
  workspace: (ctx: RunContext) => Promise<WorkspaceFs>;
  /** The seam's optional halves — the checks floor, plan facts, the app half
   *  (`AppsRuntime.authored`) and source persistence. A screen assembled here
   *  compiles in the production dialect and passes the same floor, or it does not
   *  paint. */
  render?: (ctx: RunContext) => Omit<RenderSeamOptions, "emit">;
  /** The deployment's assembled prompt for this ctx, when composition has one. */
  system?: (ctx: RunContext) => Promise<string | undefined>;
  /** The host's theme tokens and design rules (`hostDesignBrief` in
   *  `@vendoai/apps`). A thunk, not a value: `designRules` resolves per
   *  generation so a console publish applies to the next screen. */
  design?: () => string | undefined;
  /**
   * Where a run's `decisions` land: the runtime's one memory door
   * (`AppsRuntime.remember`), which this file deliberately does not reach for
   * itself — composition fills the slot exactly as it does `render` above.
   *
   * Called only for an `assembled` run, because that is the only answer whose
   * row exists by the time this returns. Unfilled, or throwing, and the run's
   * decisions are simply not recorded: a lost memory write is never worth
   * failing a screen the person can already see.
   */
  remember?: (appId: AppId, decisions: string, ctx: RunContext) => Promise<void>;
}

/**
 * The `ScreenAssembler` the front door routes into.
 *
 * The layering is why this door exists at all — and why this file lives in the
 * umbrella. `@vendoai/apps` depends on `core` alone, so the `vendo_make` handler
 * cannot reach a harness; and `@vendoai/harnesses` no longer reaches apps, so
 * the loop that needs `vendo()` AND the render seam can only live here. The two
 * meet on core's `ScreenAssembler` and composition — the one place that already
 * holds the store, the guard-bound registry, the seats and the seam — is what
 * fills the slot. Unfilled, `vendo_make` behaves exactly as it did.
 *
 * The tool surface here is projected off the registry rather than off a `Turn`,
 * for the same reason the conductor's `queryRunner` is: this call is INSIDE a
 * tool the resident already mirrored and audited, so re-mirroring the assembly
 * loop's own reads would double every call in the transcript. The guard is the
 * same guard either way — that is the part that cannot be skipped.
 */
export function screenAssembler(deps: ScreenAssemblerDeps): ScreenAssembler {
  return {
    async assemble(request: ScreenRequest, ctx: RunContext): Promise<ScreenOutcome> {
      const base = await deps.workspace(ctx);
      // ONE wrap for the whole screen path, here: composition hands the seam's
      // options and never has to know that a workspace must be wrapped before an
      // assembly writes to it.
      const workspace = wrapWorkspaceForRender(base, {
        ...deps.render?.(ctx),
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
        emit: (_streamId, part) => request.onView?.(part),
      });
      const system = await deps.system?.(ctx);
      const design = deps.design?.();
      const result = await assembleScreen(
        {
          models: deps.models,
          tools: registryTools(deps.tools, ctx),
          workspace,
          // The front door owns cancellation: `vendo_make` resolves or it does
          // not, and the tool bridge is what a caller aborts.
          signal: new AbortController().signal,
          ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
        },
        {
          appId: request.appId,
          request: request.request,
          ...(system === undefined ? {} : { system }),
          ...(design === undefined ? {} : { design }),
        },
      );
      if (result.kind !== "assembled") return result;
      if (result.decisions !== undefined) {
        await deps.remember?.(request.appId, result.decisions, ctx).catch((error: unknown) => {
          console.warn(`[vendo] the screen agent's decisions were not recorded on ${request.appId} — ${
            error instanceof Error ? error.message : String(error)
          }`);
        });
      }
      return { kind: "assembled" };
    },
  };
}

/**
 * `TurnTools` over the guard-bound registry.
 *
 * Three statuses out of seven, exactly as the harness contract's `ToolResult`
 * defines them (§1.1): `blocked` and `connect-required` are the guard saying no,
 * and a parked approval is not something an assembly loop can wait for — so it
 * reads as denied with the reason, which is what the model needs in order to
 * write around it rather than bind a value it never got.
 */
function registryTools(registry: ToolRegistry, ctx: RunContext): TurnTools {
  return {
    async list(): Promise<ToolListing[]> {
      const descriptors = await registry.descriptors(ctx).catch(() => []);
      return descriptors.map((descriptor) => ({
        name: descriptor.name,
        title: descriptor.title ?? descriptor.name,
        description: descriptor.description,
        risk: descriptor.risk,
        ...(descriptor.inputSchema === undefined ? {} : { inputSchema: descriptor.inputSchema }),
        ...(descriptor.outputSchema === undefined ? {} : { outputSchema: descriptor.outputSchema }),
      }));
    },
    async call(name, args) {
      const outcome = await registry.execute(
        { id: `call_${globalThis.crypto.randomUUID()}`, tool: name, args },
        ctx,
      );
      if (outcome.status === "ok") return { status: "ok", output: outcome.output };
      if (outcome.status === "error") return { status: "error", error: outcome.error };
      if (outcome.status === "blocked") return { status: "denied", reason: outcome.reason };
      if (outcome.status === "connect-required") {
        return {
          status: "denied",
          reason: `${outcome.connect.toolkit} is not connected, so this cannot be read.`,
          needs: { kind: "connect", toolkit: outcome.connect.toolkit },
        };
      }
      return {
        status: "denied",
        reason: "This one needs the person's approval, which cannot be asked for here.",
        needs: { kind: "approval", approvalId: outcome.approvalId },
      };
    },
  };
}
