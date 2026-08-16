/**
 * The screen agent — UI-generation blueprint §4.2 and §4.5.
 *
 * It is `vendo()` with a CLOSED loadout and a tight step budget, not a harness of
 * its own: the assembly verbs and the host's read tools by name, two hands of its
 * own, and one door out. There is no second drive of `startTurn` here — the step
 * cap, the seat resolution, `wireErrorMessage`, the history knobs and the system
 * precedence are the default harness's, so a rail cannot be fixed in one loop and
 * stay broken in the other. What this file holds is the CONFIGURATION: the brief,
 * the loadout, the hands, and the outcome the front door reads.
 *
 * - **The write path is `turn.workspace`.** The `claudeCode()` harness already
 *   builds apps this way: the model writes the app with its own hands and the
 *   runtime's commit is what makes it real (`claude-code/index.ts:338`,
 *   `skills/building-apps.ts:68`). This agent has no disk and no shell, so its two
 *   writing hands over the same `WorkspaceFs` — the whole screen, or one exact
 *   passage of it — write `app.tsx` and nothing else, through one commit path.
 * - **The run's closing words are the receipt.** The loop reports what it built in
 *   its own voice, grounded in what its saves told it: whether the paint happened,
 *   and what each query delivered. `vendo_make` relays those words verbatim
 *   (`make-receipt.ts`), so nothing downstream describes a screen it never saw.
 * - **The paint path is the render seam.** `wrapWorkspaceForRender` intercepts
 *   `commit()`, compiles, and emits `data-vendo-view`. This file never emits a
 *   view and never compiles anything — that is exactly why a screen it assembles
 *   passes the same floor a `claudeCode()` app does.
 * - **`vendo_make` is withheld, not merely unused.** The screen agent IS what
 *   `vendo_make` calls, so leaving it callable is a loop. The closed loadout
 *   excludes it by omission.
 * - **The job description is the shipped skill.** `buildingAppsSkill` plus its
 *   `references/format.md` are the same text `claudeCode()` reads. This file adds
 *   one short block that corrects the ENVIRONMENT (no disk, no delegation, one
 *   file, one door out) rather than restating the job — a third prompt is the
 *   thing §0 forbids.
 *
 * Screens run UNSANDBOXED, by §6.5: a description is data, its props are
 * schema-validated, and the kit treats them as inert. There is no box here.
 */
import {
  VENDO_MAKE_TOOL,
  log,
  mintTurnId,
  type AppId,
  type CommitResult,
  type Json,
  type SeatModels,
  type RunContext,
  type ToolListing,
  type ToolRegistry,
  type TurnId,
  type TurnSkills,
  type TurnState,
  type TurnTools,
  type UIPayload,
  type VendoViewPart,
  type WorkspaceFs,
  type Turn,
  inputSchemaIsBlind,
  modelToolDescription,
  UNKNOWN_INPUT_SCHEMA_NOTE,
  UNKNOWN_OUTPUT_SHAPE_NOTE,
} from "@vendoai/core";
import {
  renderBriefingPack,
  type BriefingPack,
  type Finding,
  type ScreenAssembler,
  type ScreenOutcome,
  type ScreenRequest,
} from "@vendoai/apps/contract";
import {
  buildingAppsSkill,
  paintedIn,
  repairInstruction,
  SCREEN_FILE,
  screenName,
  VALIDATE_TOOL,
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
 * grow on screen), fix whatever a save reports (1–2), and one step to
 * speak. `instant()`'s `ACT_STEPS = 2` is a specialist that must not think;
 * `DEFAULT_MAX_STEPS = 20` is a resident that may. A screen is neither, and the
 * cap is the definition of "cheap": an ask that needs more than this is an ask
 * for a BUILD, and `escalate` is the honest exit rather than a bigger number.
 */
export const SCREEN_STEPS = 10;

/** The repair round's whole budget. The findings name the exact thing to change,
 *  so a fix lands in one to three moves — save, read what came back, save again —
 *  or it does not land at all; a second full budget only buys a rewrite of a
 *  screen the person is already looking at. */
export const REPAIR_STEPS = 3;

/** The one door out of assembly (§4.5). Never `vendo_`-prefixed: the loadout's
 *  `isAlwaysActive` would make it un-gateable, and this tool is the screen
 *  agent's own, not a product capability anybody else may reach. */
export const ESCALATE_TOOL = "escalate";

/** The file hand. One document and no path argument — a screen agent has exactly
 *  one app directory, and a tool that takes a path is a tool that can write
 *  outside it. */
export const SAVE_APP_TOOL = "save_app";

/** The edit hand — the same document, one passage at a time. A sibling rather
 *  than a second shape of `save_app`: "exactly one of `content` or `edit`" is a
 *  rule a JSON schema cannot state, so it would be enforced in prose and paid for
 *  at runtime, on the one hand this loop calls most. Two hands say it in the
 *  shape. Both land through the same commit and hear the same checks. */
export const EDIT_APP_TOOL = "edit_app";

/**
 * The assembly verbs, by NAME rather than by risk.
 *
 * Names, because a grade is not this file's to lean on: host read tools come in
 * by risk below; these come in by name, and stay.
 *
 * `validate` comes OFF by name, for the mirror reason: it is graded `read` too, so
 * the risk half re-equips it unless something says not to (`callable` below).
 * Every save is already gated by the floor on its way to the screen and told what
 * it says (`save_app` below), and every finished screen faces the mandatory check
 * at the end whether or not anybody asked. A model-facing verb on top of those two
 * buys nothing but steps off a ten-step budget.
 */
const ASSEMBLY_TOOLS: readonly string[] = [
  "vendo_apps_data_list",
  "vendo_apps_open",
  "ask_user",
];

/**
 * Vendo's own machinery, which is never a button.
 *
 * The brief's tool section is the loadout's complement, so whatever this loop
 * cannot call is offered to it as something a screen may WIRE. That reading is
 * right for a host's write tools and wrong for these: a person pressing "Validate"
 * or "Schedule" is being handed the workshop rather than the product, and their
 * grade is no protection — it can move, and the complement would silently take
 * them back. Named here so the answer does not depend on it.
 *
 * The `vendo_apps_*` verbs are deliberately NOT here: opening or pinning an app is
 * a real thing a person can want a button for.
 */
const NEVER_WIRED: readonly string[] = ["validate", "schedule"];

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
  /**
   * What this app's LAST PAINT actually delivered, per declared query.
   *
   * The gauntlet runs a screen's queries while it paints it, so the painted view
   * is the only place that answer exists — and `emit` belongs to
   * whoever wrapped the workspace, never to this loop, exactly as `paintedIn`'s
   * verdict does. So the wrapper reads it off the part it emitted and answers
   * here. Absent, or `undefined`, claims NOTHING: an unwrapped workspace has no
   * paint to report and this loop never invents one.
   */
  readonly queryOutcomes?: () => readonly QueryOutcome[] | undefined;
  /**
   * Why this app's last save did not PAINT — the checks floor's own repair
   * instructions for the screen it refused.
   *
   * Read off the floor for the same reason `queryOutcomes` is read off the paint:
   * the refusal happens inside the seam's commit, which belongs to whoever wrapped
   * the workspace, and the seam's only channel for it is a log. Absent, or empty,
   * claims NOTHING — an unwrapped workspace has no floor to have refused anything.
   */
  readonly screenIssues?: () => readonly string[];
}

/** One declared query's outcome at paint time. `rows` is absent when the answer
 *  is not countable — a single object is an answer too. */
export interface QueryOutcome {
  name: string;
  /** Did the call come back with data? A query that FAILED — errored, blocked,
   *  refused — contributes nothing, and every binding on it renders "—". */
  delivered: boolean;
  rows?: number;
}

export interface ScreenInput {
  /** The app whose files this run writes. Minted by the caller so the file path,
   *  the view's stream id and any receipt all name the same app. */
  appId: AppId;
  /** The person's ask, verbatim. */
  request: string;
  /** The surface this screen renders into, in CSS pixels, when the host knows it.
   *  The one fact about the render target a writer cannot learn from anything
   *  else it is given — which is how eight-column tables and four-across stat
   *  rows keep landing on a narrow panel, where the person, not the loop,
   *  discovers the clip. Absent claims NOTHING: no width is invented, and the
   *  brief then says nothing about the surface at all. */
  viewport?: { width: number; height: number };
  /** THE briefing pack, already rendered (`renderBriefingPack`) — the host's
   *  theme, design rules, product brief, component catalog and tool shape card,
   *  in the same bytes the box rung is handed. Knowledge, not instruction, so it
   *  sits with the job description rather than with the deployment's voice. */
  briefing?: string;
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

/** The screen artifact, by the name the seam watches and the manual teaches
 *  (`@vendoai/apps` `SCREEN_FILE`) — one spelling, or a save paints nothing. */
const APP_FILE = SCREEN_FILE;

/** §3.1's frozen layout, personal mount. A NEW app is always `/user/**`: a fresh
 *  `/orgs/<org>/apps/<id>/` path has no row to grant on, so the workspace façade
 *  refuses the commit and the file never lands (see `AppsRuntime.authored`). */
const appDirectory = (appId: AppId): string => `/user/apps/${appId}`;



/**
 * The host tools a screen may WIRE, as the model reads them before writing a
 * button — and ONLY those.
 *
 * A tool on the loadout is already mounted with its own description and its own
 * JSON Schema (`equipClosedLoadout`), so writing it out here again is the same
 * tool twice in one prompt. What is left over is the write side of the registry:
 * the tools this loop may never call, but which an `on*` attribute may name. That
 * is the only part of the registry the model's own tool list cannot tell it about.
 *
 * EVERY tool gets both lines. A slot nothing could read prints its unknown
 * sentence rather than nothing (outputs) or a bare `{}` (inputs): `{}` reads as
 * "takes no arguments", so a blind tool would be called with none. A DECLARED
 * empty input still prints its schema — that IS the host's contract.
 */
export function toolBrief(wireable: readonly ToolListing[]): string {
  if (wireable.length === 0) return "This product has no tools your screen could call.";
  return wireable
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
 * Where the document stops agreeing with a quote that did not match.
 *
 * The longest prefix of `find` the document DOES contain, and then what the
 * document really says from there — a mismatch is nearly always a near miss (a
 * re-wrapped line, an attribute that changed on an earlier save), so the useful
 * answer is the real text at the point of divergence rather than "not found".
 * Prefixes nest, so the longest matching one is a plain binary search; a first
 * fragment that matches nothing at all has no place to point at.
 */
const nearest = (document: string, find: string): string => {
  let low = 0;
  let high = find.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (document.includes(find.slice(0, mid))) low = mid;
    else high = mid - 1;
  }
  if (low < 12) return "Read the file back and quote it character for character.";
  const at = document.indexOf(find.slice(0, low));
  return `Your quote and the file part company after ${JSON.stringify(find.slice(0, low))}. `
    + `The file says this there:\n${document.slice(at, at + find.length + 60)}`;
};

/** How many rows an answer carried, when it is countable: the output itself, or
 *  the one array inside it (`{ data: [...] }`, the shape most host tools return).
 *  Undefined is "delivered, uncountable" — never zero, which is a claim. */
const rowsIn = (output: Json): number | undefined => {
  if (Array.isArray(output)) return output.length;
  if (output === null || typeof output !== "object") return undefined;
  const arrays = Object.values(output).filter((value): value is Json[] => Array.isArray(value));
  return arrays.length === 1 ? arrays[0]!.length : undefined;
};

/**
 * What a painted view DELIVERED, per query the document declared.
 *
 * Read off the paint itself, which is the whole point: a description says what to
 * fetch (`queries`) and the render seam spreads the resolved answers beside it
 * (`data`) on the settled paint, keyed by query name — and a query that failed is
 * simply ABSENT from that record (`ProgressiveQueryResolver`). So the facts the
 * loop hears are the facts the person's screen was painted from, rather than a
 * second run of the same calls that could disagree with it.
 */
export const paintedQueries = (payload: UIPayload): readonly QueryOutcome[] => {
  /** A COMPONENT screen's queries live on the paint's interactive half instead: the
   *  query plan names them and the answers the screen rendered on ride beside it. Every
   *  one of them delivered by construction — the gauntlet refuses a screen whose
   *  query would not answer, so a painted screen never has a failed one — which is
   *  why this reports rows and never a failure. */
  const interactive = payload["interactive"] as {
    queries?: Record<string, Json>;
    queryPlan?: readonly { tool: string }[];
  } | undefined;
  if (interactive !== undefined) {
    return (interactive.queryPlan ?? []).map(({ tool }) => {
      const output = interactive.queries?.[tool];
      const rows = output === undefined ? undefined : rowsIn(output);
      return { name: tool, delivered: true, ...(rows === undefined ? {} : { rows }) };
    });
  }
  const queries = (payload["queries"] as readonly { name: string }[] | undefined) ?? [];
  const data = payload["data"] as Record<string, Json> | undefined;
  // A paint whose app half never RAN carries no `data` key at all. Every binding
  // on it renders "—" all the same, but nothing here knows why — and "that call
  // failed" would be a reason this loop invented. Absent is honest; a failed query
  // still lands here, because a resolver that ran answers with a record.
  if (data === undefined && payload["dataUnavailable"] !== true) return [];
  return queries.map(({ name }) => {
    const output = data?.[name];
    if (output === undefined) return { name, delivered: false };
    const rows = rowsIn(output);
    return { name, delivered: true, ...(rows === undefined ? {} : { rows }) };
  });
};

/** One query's outcome as the hand tells the loop. The failure says what it COSTS
 *  the screen, because that is the part the closing summary must not paper over. */
const queryNote = ({ name, delivered, rows }: QueryOutcome): string =>
  delivered
    ? `${name}: ${rows === undefined ? "data arrived" : `${rows} rows`}`
    : `${name}: NO DATA — that call failed, so everything bound to it is blank on screen`;

/**
 * THE ONE JUDGING CALL on a finished screen — `validate({appId})`, on the app's own
 * stored row.
 *
 * Row-scoped, and only for a screen that PAINTED: the paint is what created the row
 * (`AppsRuntime.authoredScreen`), and the stored screen is the one the person is
 * about to keep — which is exactly what the reviewer is for. Its mechanical half
 * already ran as the paint gate, so this spends the model call and nothing else.
 *
 * `validateWrittenApps` is the gate: it reads `app.tsx` back out of the
 * workspace and checks it as text. A screen is not text a checker can read twice —
 * its data comes from EXECUTING it — so the verb takes the app id, and the answer is
 * relayed in that gate's own shape (`repairInstruction`) so the loop reads one kind
 * of finding.
 *
 * FAIL-OPEN, exactly like that gate: every way this could not reach a verdict is
 * reported to the operator and to nobody else. A reviewer that could not judge must
 * never be the reason a good screen dies.
 */
const judgeScreen = async (
  surface: ScreenSurface,
  appId: AppId,
  path: string,
): Promise<string | undefined> => {
  // `surface.tools`, not `turn.tools`: this call is this file's own, and it runs
  // AFTER the model has spoken — through the turn's copy it would clear the very
  // words the run is about to hand back.
  const result = await surface.tools.call(VALIDATE_TOOL, { appId });
  if (result.status !== "ok") {
    console.error(
      `[vendo] could not judge ${appId} before finishing the screen, so it was not reviewed — `
      + (result.status === "denied" ? result.reason : result.error.message),
    );
    return undefined;
  }
  const output = result.output as { ok?: unknown; findings?: unknown } | null;
  if (typeof output?.ok !== "boolean") {
    console.error(`[vendo] validate answered in a shape this gate cannot read, so ${appId} was not reviewed`);
    return undefined;
  }
  if (output.ok) return undefined;
  const findings = (Array.isArray(output.findings) ? output.findings : [])
    .filter((finding): finding is Finding =>
      typeof finding === "object" && finding !== null
      && typeof (finding as { message?: unknown }).message === "string");
  return repairInstruction([{ path, appId, findings }]);
};

/** How much room the screen has, when the host said. Said ONLY then: a screen
 *  cannot measure its own surface, so a width this file guessed would read to the
 *  writer exactly like one the host measured. Absent, the paragraph above it ends
 *  where it always did. */
const surfaceNote = (viewport: ScreenInput["viewport"]): string => {
  if (viewport === undefined) return "";
  return `\n\nYou are writing into \`${viewport.width}×${viewport.height}\` CSS pixels, and nothing wider than that is
on the person's screen. Fewer, richer columns rather than a table that runs off
the edge, and a stat grid that wraps rather than a fixed count that clips.`;
};

/**
 * The environment correction, and only that.
 *
 * The shipped skill is written for a reader with a machine: a `Task` tool, a
 * `host/components/` directory, a `references/format.md` on disk, "edit the text
 * in place". None of those exist here. So these lines say what is different and
 * the skill says what the job is — which is the difference between deriving a
 * brief and forking one.
 */
const environmentNote = (input: ScreenInput, wireable: readonly ToolListing[], steps: number): string => `# In this loop

You have no machine: no shell, no \`Task\`, no files on disk. Everything the skill
above tells you to read is already below, and everything it tells you to write goes
through the tools below.

Build from the components that already exist: this product's own catalog and the
standard Kit the manual documents. There is nothing else to import.${surfaceNote(input.viewport)}

- **\`${SAVE_APP_TOOL}\`** saves this app's whole file. The app is
  \`${input.appId}\`; you never name a path. Every save that parses repaints the person's
  screen, so save as you go — a save is cheap and silence is not. Every save is checked as it
  lands — if something is wrong with it, the save tells you exactly what to fix.
  It also tells you what the person's screen actually GOT: whether the save
  painted, and what each of your queries delivered.
  Its \`decisions\` is this app's MEMORY, and the only thing the next editor will
  have besides the file. Record what reading the file could not tell them — why
  you narrowed something, a constraint the tools imposed, a shape you ruled out. Never record what you did or in what order; that is narration, and
  it crowds out the one line that mattered.
- **\`${EDIT_APP_TOOL}\`** replaces one exact passage of the file you already
  saved. Fixing an error? Send an edit, not a rewrite. Quote the text that goes in
  \`find\`, write what replaces it in \`replace\`, and quote enough of it to match
  in exactly one place — everything the person is already looking at then stays
  where it is. It lands and is checked exactly like a save.
- **\`${ESCALATE_TOOL}\`** is the one door out. Writing one screen out of this
  product's components is all you can do; anything that needs real code, its own
  server, a file the person uploads, a surface these components cannot express,
  or any part that must run while nobody is watching — a schedule, a product
  event — goes through it. A view you could assemble does not keep an ask here:
  if part of it runs away from the browser, escalate the WHOLE ask. The builder
  gets the person's own ask verbatim and does its own thinking, so all you write
  is one plain sentence saying what assembly cannot do here.
- \`${steps}\` steps is this round's whole budget. Escalate rather than run out of it.

Never look for a tool that builds the app for you. There isn't one, and that is
deliberate.

## Your last words are what the person is told

When you have stopped working, say what they now have — one or two plain
sentences, in their words, and nothing else after it. Those exact words are what
the assistant repeats to them, so they can only claim what your saves reported:
what painted, and what each query delivered. If a query brought back no data or a
save never reached the screen, say that plainly instead of describing the part that
is blank.

## This product's tools your screen can CALL, but you cannot call here

The screen calls one as \`tools.<name>(args)\` from an event handler, and that is
the only way an app of yours changes anything.

${toolBrief(wireable)}`;

/** The full brief: the shipped job description, the shipped file manual, the
 *  briefing pack, then what is different here. The manual and the environment
 *  note are this rung's own INSTRUCTIONS — the box is told a different job in
 *  its own words; the pack between them is the product knowledge both rungs
 *  read byte for byte (`contract/briefing.ts`). */
function screenBrief(input: ScreenInput, wireable: readonly ToolListing[], steps: number): string {
  return [
    buildingAppsSkill.body,
    buildingAppsSkill.files?.[`references/${"format.md"}`],
    input.briefing,
    environmentNote(input, wireable, steps),
  ]
    .filter((section): section is string => section !== undefined && section.trim().length > 0)
    .join("\n\n---\n\n");
}

/** What the two hands recorded, for THIS run. A collector on the run rather than
 *  module state: the hands are built per run and closed over it, so two concurrent
 *  assemblies cannot read each other's verdict. */
interface RunRecord {
  /** Did an `app.tsx` save ever reach the store? */
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
  // and the screen agent is the app-writing agent, so it thinks with `apps` and
  // a turn without that seat is the caller's composition bug, named loudly
  // rather than limped past. Same posture as `vendo()`, on its own seat.
  if (surface.models.apps === undefined) {
    throw new Error("the screen agent thinks with `turn.models.apps`, and this turn carries no apps seat");
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

  /**
   * Land a whole document and answer with WHAT HAPPENED TO IT — the one path both
   * hands take, so an edit is checked, painted and reported exactly like a save.
   *
   * The three facts it reports are the three the closing summary is written from,
   * and none of them is this loop's opinion: the commit says whether the bytes
   * landed, `paintedIn` says whether they reached the screen, and the paint itself
   * says what each query delivered.
   */
  const landApp = async (turn: Turn<unknown>, content: string, decisions?: string): Promise<Json> => {
    const committed = await save(turn, APP_FILE, content);
    if (committed.status !== "ok") {
      return { saved: false, note: "The save did not land — someone else changed this app. Save again." };
    }
    record.assembled = true;
    // The screen's own title — its default export's name (`screenName`), which is
    // the same reading the app's ROW takes of it (`AppsRuntime.authoredScreen`), so
    // the receipt and the person's app list cannot disagree.
    record.title = screenName(content);
    // The last save that had something to say wins the run. An omitted or blank
    // `decisions` on a later save is "nothing to add", not "forget the earlier
    // one" — a save-as-you-go loop would otherwise erase its own memory on the
    // save that fixes a finding.
    if (decisions !== undefined && decisions.trim() !== "") record.decisions = decisions;
    /**
     * A SAVE THAT NEVER REACHED THE SCREEN HEARS WHY — in the checks floor's own
     * sentences, on the one case this loop had no door for.
     *
     * Live 2026-08-06 ("a dashboard for my upcoming bills"): a save the seam would
     * not paint leaves no ROW — no paint, no row — and the row-scoped
     * `validate({appId})` answered "app not found" on exactly the document that
     * needed judging, so the loop heard nothing, saved again, and the screen the
     * person kept was judged by nothing it could hear from.
     *
     * The verdict comes from the FLOOR rather than from a second checking call,
     * because for a screen the floor's refusal IS the reason nothing painted: the
     * gauntlet compiled it, scanned it, type-checked it, ran its queries and
     * rendered it, and each line it hands back is a repair instruction. Re-checking
     * the same bytes through `validate` would pay for all of that twice to be told
     * the same thing. Relayed verbatim, in the same shape the builder's gate uses
     * (`repairInstruction`), so the loop reads one kind of finding.
     *
     * Only when the paint did NOT happen: a painted save already passed, so
     * anything more would second-guess the seam. `painted` absent means an
     * unwrapped workspace — nothing known, so nothing claimed.
     */
    const painted = paintedIn(committed);
    record.painted = painted?.includes(input.appId) ?? false;
    if (painted !== undefined && !record.painted) {
      const blocking = surface.screenIssues?.() ?? [];
      const instruction = repairInstruction(blocking.length === 0 ? [] : [{
        path: `${directory}/${APP_FILE}`,
        appId: input.appId,
        findings: blocking.map((message) => ({ severity: "block" as const, message })),
      }]);
      // A floor that said nothing this loop can read — an unwired `component` door,
      // a screen refused before the gauntlet, a workspace wrapped without the seam
      // — leaves only the fact this hand does have. It is enough to act on, and
      // claiming a verdict nothing reached is what sent the loop back through a
      // call that could never succeed.
      return {
        saved: true,
        painted: false,
        note: instruction ?? "That save landed but did not reach the person's screen. Save a simpler screen.",
      };
    }
    // The data facts, only where there is a paint to read them off: they come from
    // the view the person is looking at, so no paint means nothing known.
    const queries = record.painted ? surface.queryOutcomes?.() ?? [] : [];
    return {
      saved: true,
      // Omitted, never `false`, on an unwrapped workspace: this loop does not know.
      ...(painted === undefined ? {} : { painted: record.painted }),
      ...(queries.length === 0 ? {} : { data: queries.map(queryNote) }),
      note: "That save landed.",
    };
  };

  /** The memory block. Both hands take it — an edit that fixes a finding is
   *  exactly where a constraint gets learned — but only this one spends the prompt
   *  saying what it is; the other points here. The same paragraph twice in one
   *  tool list teaches nothing the second time. */
  const decisionsProperty = {
    type: "string",
    description:
      "What the next person to edit this app must know: choices you made, constraints you found, things "
      + "you ruled out. Only what is invisible from the document itself — never a narration of your work. "
      + "It REPLACES this app's decisions, so write the whole block each time, under 5 lines.",
  };

  const saveApp: HarnessHand = {
    name: SAVE_APP_TOOL,
    description:
      "Save this app's whole file. The person's screen repaints on every save that parses, so save "
      + "as you go rather than once at the end. Returns whether the save landed, whether it reached the "
      + "person's screen, and what each of the screen's queries delivered.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "The whole file: one React component, default-exported, as the manual writes it.",
        },
        decisions: decisionsProperty,
      },
      required: ["content"],
      additionalProperties: false,
    },
    execute: async (args, turn) => {
      const { content, decisions } = args as { content: string; decisions?: string };
      return await landApp(turn, content, decisions);
    },
  };

  const editApp: HarnessHand = {
    name: EDIT_APP_TOOL,
    description:
      "Change one exact passage of the file you already saved: `find` goes, `replace` takes its place. "
      + "Use it to fix an error rather than saving the whole file again — the rest of the screen the "
      + "person is looking at then stays exactly where it is. `find` must appear in the file exactly "
      + "once, character for character. Lands and reports exactly like a save.",
    inputSchema: {
      type: "object",
      properties: {
        find: {
          type: "string",
          description:
            "The text to replace, exactly as the file has it — enough of it to appear in only one place.",
        },
        replace: { type: "string", description: "What goes there instead." },
        decisions: {
          type: "string",
          description: `Same decisions record as \`${SAVE_APP_TOOL}\` — it replaces this app's whole block.`,
        },
      },
      required: ["find", "replace"],
      additionalProperties: false,
    },
    execute: async (args, turn) => {
      const { find, replace, decisions } = args as { find: string; replace: string; decisions?: string };
      const document = await turn.workspace.readFile(`${directory}/${APP_FILE}`).catch(() => undefined);
      if (document === undefined) {
        return { saved: false, note: `There is no file to edit yet — save the whole screen with ${SAVE_APP_TOOL} first.` };
      }
      // Every code editor's find/replace rule, and for the same reason: a quote
      // that matches twice cannot say which one the person meant, and one that
      // matches nowhere is describing a document that does not exist. Neither
      // touches the file, and both come back naming the real text — a mismatch is
      // almost always a near miss, and the fix is a better quote, not a rewrite.
      const matches = document.split(find).length - 1;
      if (matches !== 1) {
        return {
          saved: false,
          note: matches > 1
            ? `That text appears ${matches} times, so nothing was changed. Quote more of what surrounds it, `
              + "until it matches in exactly one place."
            : `That text is not in the file, so nothing was changed. ${nearest(document, find)}`,
        };
      }
      // Spliced by index, never `String.replace`: with a string pattern that
      // method still expands `$&`, `` $` `` and `$$` in the REPLACEMENT, and these
      // documents are full of dollar signs.
      const at = document.indexOf(find);
      return await landApp(turn, document.slice(0, at) + replace + document.slice(at + find.length), decisions);
    },
  };

  const escalate: HarnessHand = {
    name: ESCALATE_TOOL,
    description:
      "Hand this ask to the builder, which has real code, a real machine and no step budget. Use it when "
      + "assembling a screen out of this product's components genuinely cannot serve the ask. The person's "
      + "own ask is the builder's brief — say only why assembly cannot serve it. This ends your turn.",
    inputSchema: {
      type: "object",
      properties: {
        why: { type: "string", description: "One plain sentence: what assembly cannot do here." },
      },
      required: ["why"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const { why } = args as { why: string };
      // §4.5: no consent step and no ceremony. The builder gets the person's
      // ORIGINAL ask plus this one line and does its own thinking — so the only
      // thing this returns is the fact that the hand-off happened.
      record.escalated = why;
      return { handedOver: true };
    },
  };

  // The small loadout, resolved where the listings are: the assembly verbs by
  // name, plus the host's read tools so a query's real values can be learned when
  // a tool declares no shape. `vendo_make` is excluded by name — it is what called
  // this loop — and a mutating host tool is not an assembly tool. Names, not a
  // risk filter passed downward: the closed list stays a list, and the one place
  // that can decide "is this an assembly tool" is the one holding the listing.
  const offered = listings.filter((listing) => listing.name !== VENDO_MAKE_TOOL);
  // `validate` is refused by name before the grade is ever consulted: the registry
  // grades it `read` (`vendo-verbs.ts`'s `DESCRIPTORS`), so the risk half below is
  // exactly how it kept coming back. See `ASSEMBLY_TOOLS` for why this loop does
  // not carry it.
  const callable = (listing: ToolListing): boolean =>
    listing.name !== VALIDATE_TOOL
    && (ASSEMBLY_TOOLS.includes(listing.name) || listing.risk === "read");
  const loadout: Array<string | HarnessHand> = offered.filter(callable).map((listing) => listing.name);
  // The other half of the same split, and the whole of the brief's tool section:
  // what a button may name and this loop may not call. Split ONCE, from one
  // predicate, so a tool can never be both equipped and described as un-callable —
  // the equipped ones arrive with their own schemas (`equipClosedLoadout`), and
  // saying them again in prose is the same tool twice. `NEVER_WIRED` comes off
  // this half only, and it is what catches `validate` on the way through: refusing
  // to equip a verb drops it into the complement, and "this loop cannot call it" is
  // not the same claim as "hand the person a button for it".
  const wireable = offered
    .filter((listing) => !callable(listing))
    .filter((listing) => !NEVER_WIRED.includes(listing.name));

  /**
   * What the run said after its LAST action — the closing words, which become the
   * receipt's `say` verbatim (`make-receipt.ts`).
   *
   * Every action OF THE MODEL'S clears it, and that is the whole definition: prose
   * written between two tool calls is the model thinking out loud, and the summary
   * is what it says once it has stopped working. This file's own gate calls go
   * through `surface.tools` precisely so they are not mistaken for one of them.
   * Nothing here composes a sentence — a run that says nothing hands back nothing,
   * and the front door falls back.
   */
  let closing = "";
  /** Every hand clears the closing words, exactly as a host call does below. */
  const acting = (hand: HarnessHand): HarnessHand => ({
    ...hand,
    execute: async (args, turn) => {
      closing = "";
      return await hand.execute(args, turn);
    },
  });
  loadout.push(acting(saveApp), acting(editApp), acting(escalate));

  const turn: Turn<VendoHarnessOptions> = {
    messages: [{ id: `screen_${input.appId}`, role: "user", parts: [{ type: "text", text: input.request }] }],
    // The listings are read ONCE and handed back verbatim: a closed loadout has
    // nothing to discover, so re-reading them mid-run would be a second projection
    // of the same static menu.
    tools: {
      call: (name, args) => {
        closing = "";
        return surface.tools.call(name, args);
      },
      list: async () => listings,
    },
    skills: NO_SKILLS,
    workspace: surface.workspace,
    // `vendo()` thinks with the turn's `default` seat, and the loop it drives
    // HERE is the app-writing one — so the seat this agent runs on is what the
    // inner harness is handed as its default.
    models: { ...surface.models, default: surface.models.apps },
    state: runState(),
    options: {},
    signal: surface.signal,
    // Nobody is listening live: an approval this loop cannot show is a denial with
    // a reason (see `registryTools`). What it SAYS at the end still travels — the
    // front door speaks those words as the receipt.
    interactive: false,
    threadId: surface.threadId ?? `screen_${input.appId}`,
    turnId: surface.turnId ?? mintTurnId(),
  };

  /** The first thing that went wrong, in the shipped loop's own words
   *  (`wireErrorMessage`, applied inside `vendo()`). */
  let failure: string | undefined;
  /** The budget of the drive that is running, which is what the brief states.
   *  The repair round has `REPAIR_STEPS`, not the whole assembly budget, and a
   *  brief that says otherwise tells the model to plan for steps it has not got. */
  let budget = SCREEN_STEPS;
  const harness = vendo({
    tools: loadout,
    maxSteps: SCREEN_STEPS,
    // The brief WINS over `turn.system`: it already folds the deployment's prompt
    // in as its first section, so letting the turn's copy through would say it
    // twice.
    system: () => screenBrief(input, wireable, budget),
  });
  /**
   * One drive of the loop. The events MUST be drained or nothing runs. The text
   * events are KEPT — they are the run's own report of what it built, and the
   * receipt is those words rather than a sentence this file wrote about them.
   *
   * It takes the messages because the review below needs a SECOND drive, and a
   * repair round that went through different code than the turn would be a second
   * way to drive the same loop (`claude-code/index.ts`'s `round` for the same
   * reason).
   */
  const drive = async (
    messages: Turn<VendoHarnessOptions>["messages"],
    options: VendoHarnessOptions = turn.options,
  ): Promise<void> => {
    budget = options.maxSteps ?? SCREEN_STEPS;
    for await (const event of harness.run({ ...turn, messages, options })) {
      if (event.type === "error") failure ??= event.message;
      if (event.type === "text") closing += event.delta;
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
     * THE MANDATORY REVIEWER PASS — every finished screen faces it, and it is the
     * only thing that asks: this loadout carries no `validate` verb, so nothing
     * depends on a model volunteering to be judged.
     *
     * Live 2026-08-06 (demo-bank, "a dashboard for my upcoming bills and
     * subscriptions"): the screen summed two overlapping query results into an
     * $11,216 headline over ~$6,276 of real bills. Every mechanical check passed —
     * a double count is not a shape error — and the one check that could have seen
     * it never ran, because back then it fired only when the writing model chose to
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
    const instruction = record.painted ? await judgeScreen(surface, input.appId, appPath) : undefined;
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
            : `${instruction}\n\nThis is the document you saved. Fix what the findings name — `
              + `an edit of the passages that are wrong, not a rewrite:\n${saved}`,
        }],
      }], { maxSteps: REPAIR_STEPS });
    }
    const say = closing.trim();
    return {
      kind: "assembled",
      ...(record.title === undefined ? {} : { title: record.title }),
      ...(record.decisions === undefined ? {} : { decisions: record.decisions }),
      // The run's own closing words, or nothing. Never a sentence this file wrote:
      // the front door is the one place that has a fallback, and it is the shipped
      // one (`make-tool.ts`).
      ...(say === "" ? {} : { say }),
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
  /** The seam's optional halves — the checks floor and source persistence. A
   *  screen assembled here passes the same floor every other author's does, or it
   *  does not paint. */
  render?: (ctx: RunContext) => Omit<RenderSeamOptions, "emit">;
  /**
   * THE briefing pack (`AppsConfig.briefing`, assembled in
   * `compose-surfaces.ts`) — everything this host's writers are told about the
   * product. Two slots collapsed into one on purpose: the theme and design
   * rules and the tool shape card were two seams with two owners and two
   * arrival routes, which is how the box rung ended up with neither.
   *
   * Per call and ctx-taking: `designRules` re-resolves per generation so a
   * console publish applies to the next screen, and the shape card is projected
   * for THIS caller's tools.
   */
  briefing?: (ctx: RunContext) => Promise<BriefingPack>;
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
      /** The last SETTLED paint of this app, kept as it goes past on its way to the
       *  person's screen. It is the only place the resolved query answers exist —
       *  the seam spreads them beside the description on the final paint — so the
       *  facts the loop hears are the facts the person is looking at. A still-
       *  streaming skeleton has none of them yet, and never overwrites one. */
      let painted: VendoViewPart | undefined;
      const options = deps.render?.(ctx) ?? {};
      /** Why the floor last refused this app's screen. The seam's own channel for a
       *  refusal is a log line to the operator, so the verdict is kept HERE, on the
       *  way past — the same reading as `painted` above, for the same reason. */
      let refused: readonly string[] = [];
      // ONE wrap for the whole screen path, here: composition hands the seam's
      // options and never has to know that a workspace must be wrapped before an
      // assembly writes to it.
      const floor = options.floor;
      const gauntlet = floor?.component?.bind(floor);
      const workspace = wrapWorkspaceForRender(base, {
        ...options,
        ...(floor === undefined || gauntlet === undefined ? {} : {
          floor: {
            ...floor,
            component: async (input) => {
              const result = await gauntlet(input);
              refused = result.ok ? [] : result.blocking;
              return result;
            },
          },
        }),
        ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
        emit: (_streamId, part) => {
          if (part.payload["streaming"] !== true) painted = part;
          request.onView?.(part);
        },
      });
      const pack = await deps.briefing?.(ctx);
      const result = await assembleScreen(
        {
          models: deps.models,
          tools: registryTools(deps.tools, ctx),
          workspace,
          // The front door owns cancellation: `vendo_make` resolves or it does
          // not, and the tool bridge is what a caller aborts.
          signal: new AbortController().signal,
          queryOutcomes: () => painted === undefined ? undefined : paintedQueries(painted.payload),
          screenIssues: () => refused,
          ...(ctx.turnId === undefined ? {} : { turnId: ctx.turnId }),
        },
        {
          appId: request.appId,
          request: request.request,
          ...(request.viewport === undefined ? {} : { viewport: request.viewport }),
          ...(pack === undefined ? {} : { briefing: renderBriefingPack(pack) }),
        },
      );
      if (result.kind !== "assembled") return result;
      if (result.decisions !== undefined) {
        await deps.remember?.(request.appId, result.decisions, ctx).catch((error: unknown) => {
          log({
            code: "vendo.screen-agent-decisions-not-recorded",
            level: "warn",
            message: `[vendo] the screen agent's decisions were not recorded on ${request.appId} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        });
      }
      // The run's own closing words travel — `vendo_make` speaks them verbatim as
      // the receipt's `say`, and nothing between here and there rewrites them.
      return { kind: "assembled", ...(result.say === undefined ? {} : { say: result.say }) };
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
