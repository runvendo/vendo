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
  VENDO_SLOTS_LIST_TOOL,
  isVendoError,
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
} from "@vendoai/core";
import {
  queryKey,
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
  unpaintedIn,
  SCREEN_FILE,
  screenName,
  VALIDATE_TOOL,
  wrapWorkspaceForRender,
  type RenderSeamOptions,
} from "@vendoai/apps";
import { wrapLanguageModel, type LanguageModel } from "ai";
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
 * for a BUILD rather than an ask for a bigger number.
 */
export const SCREEN_STEPS = 10;

/** The repair round's whole budget. The findings name the exact thing to change,
 *  so a fix lands in one to three moves — save, read what came back, save again —
 *  or it does not land at all; a second full budget only buys a rewrite of a
 *  screen the person is already looking at. */
export const REPAIR_STEPS = 3;

/**
 * How hard the model works on every turn AFTER the first one.
 *
 * A screen is designed in one turn — the whole document comes out of step 0 —
 * and every step after it is a save, a patch, or the sentence about one, where
 * deliberation buys nothing and is billed by the token. `effort` is the knob for
 * that on the models this loop actually runs on: the Claude 5 line REJECTS a
 * thinking budget outright (`budget_tokens` → 400), and `@ai-sdk/anthropic`
 * carries `effort` straight through to `output_config.effort`.
 *
 * The write turn itself is left EXACTLY as the caller configured it — the
 * deployment's own default is the honest "full", and only the cheapening is
 * this file's.
 */
const PATCH_EFFORT = "low";

/**
 * The assembly seat, thinking hard once and cheaply thereafter.
 *
 * A middleware rather than the loop's own parameters, because the loop is
 * `vendo()`'s: its per-step hook carries no provider options (ai 6.0.28), so the
 * MODEL INSTANCE is the only seam this file owns. The flag lives on the instance
 * and the instance is built per run, so two concurrent assemblies cannot spend
 * each other's write turn — and the repair drive, which starts after it is
 * spent, is all patch by construction.
 *
 * A seat that is a bare model id (or a v2 model) cannot be wrapped and is handed
 * back untouched; a non-Anthropic provider ignores the namespace. Either way the
 * run is exactly what it was.
 */
const seatByRole = (model: LanguageModel): LanguageModel => {
  if (typeof model === "string" || model.specificationVersion === "v2") return model;
  let writeTurn = true;
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: "v3",
      transformParams: async ({ params }) => {
        if (writeTurn) {
          writeTurn = false;
          return params;
        }
        return {
          ...params,
          providerOptions: {
            ...params.providerOptions,
            anthropic: { ...params.providerOptions?.["anthropic"], effort: PATCH_EFFORT },
          },
        };
      },
    },
  });
};

/** The file hand. One document and no path argument — a screen agent has exactly
 *  one app directory, and a tool that takes a path is a tool that can write
 *  outside it. */
export const SAVE_APP_TOOL = "save_app";

/** The edit hand — the same document, any number of exact passages in ONE
 *  landing. A sibling rather
 *  than a second shape of `save_app`: "exactly one of `content` or `edit`" is a
 *  rule a JSON schema cannot state, so it would be enforced in prose and paid for
 *  at runtime, on the one hand this loop calls most. Two hands say it in the
 *  shape. Both land through the same commit and hear the same checks. */
export const EDIT_APP_TOOL = "edit_app";

/**
 * The door out of assembly (§4.5) — and it opens onto a QUESTION, never onto a
 * machine.
 *
 * PR #1407 took this hand off the loadout so that the model could not spend a
 * box by reaching for it, and that principle is untouched: all this hand does
 * now is record one line, which the front door turns into a standing approval
 * card (`build.propose`). The person's yes, whenever it lands, is still the only
 * thing that starts a build. Without the hand the loop had no word for "this ask
 * is bigger than a screen", so a real build was unreachable from chat at all —
 * measured live 2026-08-24, an ask needing npm packages got a degraded screen
 * and an apology.
 *
 * Never `vendo_`-prefixed: the loadout's `isAlwaysActive` would make it
 * un-gateable, and this tool is the screen agent's own, not a product capability
 * anybody else may reach.
 */
export const ESCALATE_TOOL = "escalate";

/**
 * The two verbs that read an app which ALREADY EXISTS — on an EDIT and nowhere
 * else, because the loadout follows the task.
 *
 * A fresh build's app is the file the run is about to write, so opening it or
 * listing its saved records can only answer `not-found`: two entries on a
 * ten-step menu whose one possible use is a step spent learning that. An edit
 * starts the other way round — the app already on the person's screen is the
 * thing being changed, so what it is showing is worth a step. Withheld from the
 * brief's button half too on a fresh build (`withheld` below): a screen cannot
 * offer to open an app nobody has made yet.
 *
 * NEITHER OF THESE READS THE SOURCE, and believing otherwise cost a whole
 * investigation: `vendo_apps_open` is the client's render door
 * (`apps` persistence/open.ts `paintedScreenSurface`) — it RE-RUNS the screen and
 * answers with the flattened tree plus the compiled module, deliberately, because
 * that is what a caller mounts. The `app.tsx` a run starts from reaches the model
 * as {@link ScreenInput.source} instead, and only for a remix.
 */
const EDIT_TOOLS: readonly string[] = ["vendo_apps_open", "vendo_apps_data_list"];

/**
 * The assembly verbs, by NAME rather than by risk.
 *
 * Names, because a grade is not this file's to lean on: host read tools come in
 * by risk below; these come in by name, and stay.
 *
 * `validate` comes OFF by name, for the mirror reason: it is graded `read` too, so
 * the risk half re-equips it unless something says not to (`NEVER_WIRED` below).
 * Every save is already gated by the floor on its way to the screen and told what
 * it says (`save_app` below), and every finished screen faces the mandatory check
 * at the end whether or not anybody asked. A model-facing verb on top of those two
 * buys nothing but steps off a ten-step budget.
 */
const ASSEMBLY_TOOLS: readonly string[] = ["ask_user", ...EDIT_TOOLS];

/**
 * Vendo's own machinery, which is never a button — and never a step here either
 * (`withheld` below).
 *
 * The brief's tool section is the loadout's complement, so whatever this loop
 * cannot call is offered to it as something a screen may WIRE. That reading is
 * right for a host's write tools and wrong for these: a person pressing "Validate"
 * or "Schedule" is being handed the workshop rather than the product, and their
 * grade is no protection — it can move, and the complement would silently take
 * them back. Named here so the answer does not depend on it.
 *
 * `vendo_slots_list` is the same trap one rung earlier: WHERE a view goes is the
 * caller's question and never the writer's, and its `read` grade is the whole
 * reason it kept being equipped as though it were.
 *
 * The `vendo_apps_*` verbs are deliberately NOT here: pinning an app, or opening
 * one that exists, is a real thing a person can want a button for — the two READS
 * are withheld on a fresh build by `EDIT_TOOLS`, which is a different claim.
 */
const NEVER_WIRED: readonly string[] = [VALIDATE_TOOL, "schedule", VENDO_SLOTS_LIST_TOOL];

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
  readonly screenIssues?: () => ScreenRefusal;
}

/** Why the floor refused a save, as the loop reads it. */
export interface ScreenRefusal {
  /** The checks floor's own repair instructions for the screen it refused. */
  readonly blocking: readonly string[];
  /** The refusal was about the DEPLOYMENT — the checks could not RUN here — so
   *  nothing this loop writes changes it (`ComponentPaintResult.environment`). */
  readonly environment?: true;
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
  /** The `app.tsx` this run starts from — a REMIX's ported source, and nothing
   *  else's ({@link ScreenAssemblerDeps.storedScreen} answers only for a seeded
   *  row, `replayFrom` only for a re-seed). Absent on every other edit, whose
   *  first message stays the ask alone. See {@link startingSource}. */
  source?: string;
  /** Is there a builder behind an escalation ({@link ScreenAssemblerDeps.canBuild})?
   *  The door out is equipped only where the answer is yes: a deployment with no
   *  sandbox cannot honour the offer, and `vendo_make` would answer the
   *  escalation with a failed receipt naming the gap. Absent is no. */
  canBuild?: boolean;
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
 * WHAT IT RETURNS IS NOT HERE. The briefing pack's shape card already carries
 * every tool's response, in this host's own units and annotated with them
 * (`AppsRuntime.toolShapeBrief`, TOOL RESPONSE SHAPES) — and it rides the same
 * prompt, so a raw `returns:` JSON beside it was the same shape twice, the second
 * time worse. The INPUT stays: nothing else in the prompt says what a handler
 * must send, and a button wired with guessed argument names is the one failure
 * this section exists to prevent.
 *
 * A slot nothing could read prints its unknown sentence rather than a bare `{}`:
 * `{}` reads as "takes no arguments", so a blind tool would be called with none.
 * A DECLARED empty input still prints its schema — that IS the host's contract.
 */
export function toolBrief(wireable: readonly ToolListing[]): string {
  if (wireable.length === 0) return "This product has no tools your screen could call.";
  return wireable
    .map((listing) => {
      const input = inputSchemaIsBlind(listing.inputSchema)
        ? `\n  ${UNKNOWN_INPUT_SCHEMA_NOTE}`
        : `\n  input: ${JSON.stringify(listing.inputSchema)}`;
      return `- ${listing.name} — ${modelToolDescription(listing)}${input}`;
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

/** One replacement, as the edit hand takes it. */
interface Edit {
  find: string;
  replace: string;
}

/** Enough of a quote to recognise it and no more — a `find` can be half the
 *  screen, and a refusal that repeats the whole of it teaches nothing. */
const quote = (find: string): string => (find.length > 60 ? `${find.slice(0, 60)}…` : find);

/**
 * Every edit in one call applied to ONE document, or the sentence saying which
 * edit stopped the lot.
 *
 * Matched against the ORIGINAL bytes and spliced by index, which is what makes a
 * batch atomic. Applied one at a time, each edit would change the very document
 * the next `find` was quoted against, so a model's copy goes stale halfway
 * through its own call and the second half of a repair fails for a reason it
 * cannot see. Same one-match rule as any editor's find/replace — a quote that
 * matches twice cannot say which one was meant, one that matches nowhere
 * describes a document that does not exist — and the refusal NAMES the edit that
 * broke it beside the file's real text, because a model holding five of them
 * cannot otherwise tell which one to re-quote.
 *
 * Spliced by index, never `String.replace`: with a string pattern that method
 * still expands `$&`, `` $` `` and `$$` in the REPLACEMENT, and these documents
 * are full of dollar signs.
 */
const editPlan = (
  document: string,
  edits: readonly Edit[],
): { content: string } | { refusal: string } => {
  const nothingChanged = (at: number, why: string): { refusal: string } => ({
    refusal: `Edit ${at + 1} of ${edits.length} — ${JSON.stringify(quote(edits[at]!.find))} — did not apply, `
      + `so NOTHING was changed: not that edit, and not the others. ${why}`,
  });
  const spans: Array<{ from: number; to: number; at: number; replace: string }> = [];
  for (const [at, { find, replace }] of edits.entries()) {
    const matches = document.split(find).length - 1;
    if (matches > 1) {
      return nothingChanged(at, `That text appears ${matches} times. Quote more of what surrounds it, until it `
        + "matches in exactly one place.");
    }
    if (matches === 0) return nothingChanged(at, `That text is not in the file. ${nearest(document, find)}`);
    const from = document.indexOf(find);
    spans.push({ from, to: from + find.length, at, replace });
  }
  spans.sort((left, right) => left.from - right.from);
  let content = "";
  let read = 0;
  for (const span of spans) {
    // Two quotes that each match once can still cover the same bytes, and
    // splicing both would write a document neither edit describes.
    if (span.from < read) {
      return nothingChanged(span.at, "It covers text another edit in this call also changes. Send one edit for "
        + "that passage, or quote passages that do not overlap.");
    }
    content += document.slice(read, span.from) + span.replace;
    read = span.to;
  }
  return { content: content + document.slice(read) };
};

/**
 * How a refused save is fixed: the flagged lines, and nothing else.
 *
 * This loop has a hand for exactly that, so every refusal it relays says which
 * one, and relays nothing that argues with it ({@link refusal}). Told to write
 * the file again, it did: a sixteen-hundred-token document re-emitted to move one
 * attribute, for 13 seconds and then 8 more on the same error.
 */
const PATCH_ONLY = `Fix it with \`${EDIT_APP_TOOL}\` — one edit per finding, all of them in one call, `
  + `quoting only the lines the findings name. Never save the whole document to fix one of them: `
  + `everything else is already on the person's screen and right.`;

/**
 * A refusal as this loop hands it over: the findings, then the hand that fixes
 * them — the one shape for BOTH ways a refusal reaches the model, the save's own
 * answer and the reviewer's repair round.
 *
 * The findings travel VERBATIM; the builder gate's wrapper around them does not
 * (`repairInstruction`). That wrapper heads them with "Fix each of these, then
 * write the file again. Change nothing else." — right for a builder holding a
 * whole file, and a straight contradiction of the line beneath it here. A model
 * handed both obeyed the sentence it read first: every refusal bought a whole
 * re-emitted document, ~2.5–3k tokens and 25–31 seconds each, and a measured
 * 174-second tail was three to five of them.
 */
const refusal = (path: string, findings: readonly Finding[]): string | undefined =>
  findings.length === 0 ? undefined : [
    `${path}:`,
    ...findings.map(({ where, message }) => (where === undefined ? `  - ${message}` : `  - ${where} ${message}`)),
    "",
    PATCH_ONLY,
  ].join("\n");

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
 * simply ABSENT from that record. So the facts the loop hears are the facts the
 * person's screen was painted from, rather than a second run of the same calls
 * that could disagree with it.
 */
export const paintedQueries = (payload: UIPayload): readonly QueryOutcome[] => {
  /** A COMPONENT screen's queries live on the paint's interactive half instead: the
   *  query plan names them and the answers the screen rendered on ride beside it,
   *  keyed by {@link queryKey} — the tool AND the input it asked with, because one
   *  tool read twice with different questions is two reads, and the reader has to
   *  know WHICH. Every one of them delivered by construction — the gauntlet refuses
   *  a screen whose query would not answer, so a painted screen never has a failed
   *  one — which is why this reports rows and never a failure. */
  const interactive = payload["interactive"] as {
    queries?: Record<string, Json>;
    queryPlan?: readonly { tool: string; input?: unknown }[];
  } | undefined;
  if (interactive !== undefined) {
    return (interactive.queryPlan ?? []).map((entry) => {
      const name = queryKey(entry);
      const output = interactive.queries?.[name];
      const rows = output === undefined ? undefined : rowsIn(output);
      return { name, delivered: true, ...(rows === undefined ? {} : { rows }) };
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
 * relayed as {@link refusal} writes one, so the loop reads one kind of finding
 * whichever check produced it.
 *
 * THE ASK TRAVELS WITH IT. Two of the reviewer's five things — a section nobody
 * asked for, work quietly dropped — are written against the person's own words, and
 * the verb had no field to carry them, so those two rules were dead text on every
 * screen this gate ever judged. This loop is holding the ask (it is message 1 of
 * every drive), so it hands it over verbatim.
 *
 * AND SO DOES THE SURFACE. The writer was told what it was writing into
 * (`surfaceNote`) and the reviewer was not, so it judged the file and never the
 * shape: a third table below the fold and a step behind a click read to it exactly
 * like content on the person's screen. The same loop holds both facts, so it hands
 * over both.
 *
 * FAIL-OPEN, exactly like that gate: every way this could not reach a verdict is
 * reported to the operator and to nobody else. A reviewer that could not judge must
 * never be the reason a good screen dies.
 */
const judgeScreen = async (
  surface: ScreenSurface,
  appId: AppId,
  path: string,
  request: string,
  viewport: ScreenInput["viewport"],
): Promise<string | undefined> => {
  // `surface.tools`, not `turn.tools`: this call is this file's own, and it runs
  // AFTER the model has spoken — through the turn's copy it would clear the very
  // words the run is about to hand back.
  const result = await surface.tools.call(VALIDATE_TOOL, {
    appId,
    request,
    ...(viewport === undefined ? {} : { viewport }),
  });
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
  const findings = (Array.isArray(output.findings) ? output.findings : [])
    .filter((finding): finding is Finding =>
      typeof finding === "object" && finding !== null
      && typeof (finding as { message?: unknown }).message === "string");
  /**
   * A WARN IS A REPAIR TOO — the gate reads the FINDINGS, not the verdict.
   *
   * `ok` is "no blocker", and the reviewer grades the ask rules `warn` on purpose:
   * the person spots a missing section at a glance, so a wrong `block` would throw
   * away an app that was fine. But this loop is not a person, and it is the last
   * reader before they see it — so it reads the same list they would and fixes what
   * is on it, at no risk to the screen: the repair is the same bounded round a
   * blocker gets, and whatever survives it stands. Nothing but an EMPTY verdict is
   * silence.
   *
   * TRIED THE OTHER WAY ON 2026-08-19 AND MEASURED WORSE, so do not delete this
   * again: gating the round on `block` alone saved the model spend and cost the
   * product — over 40 cases, style fell 99%→90%, asks 96%→91%, honesty 40/40→38/40
   * and the floor 100%→95.7%, with 21 screens shipping their warnings unrepaired.
   * The warn rounds were doing real polishing work.
   */
  if (output.ok && findings.length === 0) return undefined;
  return refusal(path, findings);
};

/**
 * The screen this run starts from, IN FRONT OF THE MODEL — the remix's whole
 * reason to exist, and the one thing it never had.
 *
 * A remix's first act is an edit of the host component's own ported code
 * (`remix/seed-surface.ts` `seedFrom`), and the loop checks that code out into
 * the workspace. But the workspace is not somewhere this loop can READ: the
 * loadout carries no file hand, `edit_app` can only replace passages the model
 * quotes back character for character, and `vendo_apps_open` answers with the
 * render rather than the source ({@link EDIT_TOOLS}). So the port sat staged and
 * invisible, and every remix wrote a replacement out of the catalog instead —
 * guessing a host component's props, which the checks floor then refused. The
 * ask alone could never have produced anything else.
 *
 * EVERY edit of a remix, not only the first. This was once filled from the
 * CHECKOUT, which fills an empty workspace and so had nothing to say once the
 * first edit's save had landed a file — leaving the second ask in exactly the
 * position the first was rescued from, and answered the same way.
 *
 * A message rather than a section of the brief: the brief heads a cached prefix
 * shared by every assembly, and this is one app's file.
 *
 * REMIXES ONLY. `source` is filled from the source this run starts on, which
 * exists for a seeded row and nothing else — an ordinary edit's first message is
 * still the ask, byte for byte.
 */
const startingSource = (source: string | undefined): string =>
  source === undefined ? "" : `This app already has a screen: the host's own component, ported into this
dialect, and every change already made to it.
It is below, and it is what the ask under it changes — edit THIS code, keep every
part the ask does not name, and never replace it with something built from the
catalog.

\`\`\`tsx
${source}
\`\`\`

`;

/** How much room the screen has, when the host said. Said ONLY then: a screen
 *  cannot measure its own surface, so a width this file guessed would read to the
 *  writer exactly like one the host measured. Absent, the paragraph above it ends
 *  where it always did.
 *
 *  A measured frame used to be read as a budget to spend — "fewer, richer
 *  columns", a grid that wraps — and a writer told to shed content in a small
 *  frame sheds the thing the ask named. Fit is the Kit's job, not the writer's,
 *  so the frame says what is SEEN instead of what to leave out. */
const surfaceNote = (viewport: ScreenInput["viewport"]): string => {
  if (viewport === undefined) return "";
  return `\n- You are writing into \`${viewport.width}×${viewport.height}\` CSS pixels — nothing wider than that is on
  the person's screen.
- What a person sees in that frame is all anyone sees, and EVERYTHING the ask
  names has to be in it — never dropped to make room. Fit is the Kit's job:
  cells truncate, a narrow frame keeps columns by \`priority\`, panes stack.`;
};

/** The door out, said only where a build could really follow it ({@link
 *  ScreenInput.canBuild}) — an offer this deployment cannot honour would end in
 *  a failed receipt naming a machine it has not got, which is worse than never
 *  offering. The hand is equipped under exactly the same condition. */
const doorOut = (input: ScreenInput): string => {
  if (input.canBuild !== true) return "";
  return `
- **\`${ESCALATE_TOOL}\`** is the one door out. A screen is already real code —
  logic, state, full JS — so "this needs code" is never the reason. Escalate when
  the ask needs what this room does not have:
  - a package to install — maps, rich editors, 3D, PDF: anything imported;
  - a surface this product's components and the Kit cannot express;
  - heavier computation than a screen's render budget allows.
  - It builds nothing by itself. It ASKS the person whether to have this built
    for real, and their yes — whenever it comes — is what starts it.
  - A build cannot run its own server, work while nobody is watching, or reach
    the internet. An ask that needs those gets an honest no, not an escalation.
  - A view you could assemble does not keep an ask here: if part of it needs a
    package, escalate the WHOLE ask.
  - The builder gets the person's own words, so all you write is one plain
    sentence saying what assembly cannot do.`;
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
const environmentNote = (input: ScreenInput, wireable: readonly ToolListing[]): string => `# In this loop

- You have no machine: no shell, no \`Task\`, no files on disk.
- Everything the skill above tells you to read is already below, and everything it
  tells you to write goes through the tools below.
- Build from the components that already exist: this product's own catalog and the
  standard Kit the manual documents. There is nothing else to import.
- A value the ask names must be READABLE AS TEXT on the screen — not implied by a
  chart, not behind a click.
- Never look for a tool that builds the app for you. There isn't one, and that is
  deliberate.${surfaceNote(input.viewport)}

## Your hands

- **\`${SAVE_APP_TOOL}\`** saves this app's whole file.
  - Every save that parses repaints the person's screen, so save as you go — a
    save is cheap and silence is not.
  - Every save is checked as it lands — if something is wrong with it, the save
    tells you exactly what to fix.
  - It also tells you what the person's screen actually GOT: whether the save
    painted, and what each of your queries delivered.
  - Its \`decisions\` is this app's MEMORY, and the only thing the next editor will
    have besides the file. Record what reading the file could not tell them — why
    you narrowed something, a constraint the tools imposed, a shape you ruled out.
  - Never record what you did or in what order; that is narration, and it crowds
    out the one line that mattered.
- **\`${EDIT_APP_TOOL}\`** replaces exact passages of the file you already saved.
  - Fixing errors? Send edits, not a rewrite — all of them in one call, and they
    land together or not at all.
  - Quote the text that goes in each \`find\`, write what replaces it in
    \`replace\`, and quote enough of it to match in exactly one place —
    everything the person is already looking at then stays where it is.
  - It lands and is checked exactly like a save.${doorOut(input)}

## Your last words are what the person is told

- Say what they now have IN THE SAME MESSAGE as your last save — the words and
  the save that finishes the screen travel in one turn, and a turn spent only to
  speak is a turn the person sits through.
- One or two plain sentences, in their words, and nothing after it.
- Those exact words are what the assistant repeats to them, so they can only
  claim what your saves reported: what painted, and what each query delivered —
  which is the other reason to save as you go, so the save you speak beside holds
  no surprises.
- If a query brought back no data or a save never reached the screen, say that
  plainly instead of describing the part that is blank.

## This product's tools your screen can CALL, but you cannot call here

- The screen calls one as \`tools.<name>(args)\` from an event handler, and that is
  the only way an app of yours changes anything.
- What each one RETURNS is in TOOL RESPONSE SHAPES above; below is what to send it.

${toolBrief(wireable)}`;

/** How a rung's brief joins its SECTIONS. Exported because the box's brief
 *  (`build-agent.ts`) joins its own the same way: the pack is one section on
 *  either side, so a reader can find it without counting positions. */
export const BRIEF_SECTION = "\n\n---\n\n";

/** The full brief: the shipped job description, the shipped file manual, the
 *  briefing pack, then what is different here. The manual and the environment
 *  note are this rung's own INSTRUCTIONS — the box is told a different job in
 *  its own words; the pack between them is the product knowledge both rungs
 *  read byte for byte (`contract/briefing.ts`).
 *
 *  The same bytes for every drive of one assembly, deliberately: this text heads
 *  the turn's cached prefix, so anything interpolated here that a repair round
 *  changes costs the whole prefix its cache. What varies per drive — the step
 *  budget — is that drive's own last word instead (`drive` below). */
function screenBrief(input: ScreenInput, wireable: readonly ToolListing[]): string {
  return [
    buildingAppsSkill.body,
    buildingAppsSkill.files?.[`references/${"format.md"}`],
    input.briefing,
    environmentNote(input, wireable),
  ]
    .filter((section): section is string => section !== undefined && section.trim().length > 0)
    .join(BRIEF_SECTION);
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
   *  reviewer, or is reported as one. `undefined` claims NOTHING and is not
   *  `false`: no save has faced the question, or the workspace is unwrapped and
   *  there is no paint to read, exactly as the hand's own gate reads it. */
  painted?: boolean;
  title?: string;
  escalated?: string;
  /** The run is over and the screen is not why: the DEPLOYMENT could not check
   *  it, in the floor's own words. Nothing this loop writes changes that, so the
   *  words become the run's answer instead of a repair round. */
  blocked?: string;
  /** Why the LAST save did not reach the screen, in the floor's own sentences.
   *  The run's answer when it ends there: `assembled` says only that bytes landed
   *  ONCE, so a "here it is" over whatever an earlier save painted is a stale card
   *  under a live one's words. */
  refused?: string;
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
  const record: RunRecord = { assembled: false };
  /** This run's own stop switch, beside the caller's: a hand that learns the
   *  deployment cannot check screens ends the drive the same way a caller hanging
   *  up does, rather than letting the loop pay for another step. */
  const stop = new AbortController();

  /**
   * What the run has SAID, in two halves — the closing words become the receipt's
   * `say` verbatim (`make-receipt.ts`).
   *
   * `closing` is what the model has written since its last action; `spoken` is what
   * it wrote in the same breath AS that action, because the closing words now ride
   * the final save rather than costing a turn of their own (see the brief). Between
   * them they are the whole definition: prose in the middle of the work is the model
   * thinking out loud, and the receipt is whichever half the run ends on. This
   * file's own gate calls go through `surface.tools` precisely so they are not
   * mistaken for the model's. Nothing here composes a sentence — a run that says
   * nothing hands back nothing, and the front door falls back.
   */
  let closing = "";
  let spoken = "";
  const acted = (): void => {
    spoken = closing;
    closing = "";
  };
  /** This drive's own hang-up, tripped by the save that ends the run (`drive`).
   *  Never the caller's signal: every question about whether the CALLER went away
   *  is asked of `surface.signal`, which this never touches. */
  let ended: AbortController | undefined;
  /** Has the reviewer already judged this run? ONE verdict per run, whether it was
   *  handed back inside a save or fetched by the fallback below — the repair round
   *  is capped at one, and nothing else bounds it. */
  let reviewed = false;
  /** What the run said about the SCREEN, kept from the moment a verdict bought a
   *  repair round. Everything the loop says from there answers the REVIEWER
   *  ("Fixed the double count"), and the receipt is spoken to the PERSON
   *  (`make-receipt.ts` §3.1). */
  let described: string | undefined;

  /**
   * ONE writer at a time, over the whole read-apply-write.
   *
   * A provider sends parallel tool calls, so both writing hands can run twice in
   * one step — and an edit is a READ of the document followed by a write of it.
   * Interleaved, two of them read the same pre-edit bytes and the second commit
   * throws the first one's change away while both hands answer "That save
   * landed", which is the one failure a model cannot detect from its own
   * transcript. Landings queue here instead, so each one sees the one before it.
   */
  let writing: Promise<unknown> = Promise.resolve();
  const serially = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = writing.then(work, work);
    writing = next.then(() => undefined, () => undefined);
    return await next;
  };

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
  const landApp = async (
    turn: Turn<unknown>,
    content: string,
    decisions?: string,
  ): Promise<Json> => {
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
     * the same thing. The lines are relayed verbatim, in the one shape a refusal
     * takes here ({@link refusal}), so the loop reads one kind of finding.
     *
     * Only when the paint did NOT happen: a painted save already passed, so
     * anything more would second-guess the seam. `painted` absent means an
     * unwrapped workspace — nothing known, so nothing claimed.
     */
    record.painted = paintedIn(committed)?.includes(input.appId);
    if (record.painted === false) {
      const floorSaid = surface.screenIssues?.() ?? { blocking: [] };
      // The floor's own words WIN. The seam speaks only for the exits where the
      // floor never did — no screen engine, a compiled screen that is not a valid
      // description, a view that threw — which reached the operator's console and
      // nobody else, leaving this run to answer "produced nothing that renders"
      // for three different reasons.
      const { blocking, environment } = floorSaid.blocking.length > 0
        ? floorSaid
        : unpaintedIn(committed, input.appId) ?? floorSaid;
      // A refusal about the DEPLOYMENT is not a screen this loop can fix: no
      // compiler where the checks run refuses every screen, so handing these
      // sentences over as repair instructions spends the whole budget rewriting a
      // screen nothing ever read. The run gives up here, in the floor's words.
      if (environment === true) {
        record.blocked = blocking.join(" ");
        stop.abort();
        return { saved: true, painted: false, note: record.blocked };
      }
      // The same sentences are also the RUN's answer if this save turns out to be
      // its last one. A repair round may still fix it — that is what the
      // instruction below is for — but nothing that comes after can make an
      // unpainted save into a screen, and the person hears why rather than the
      // closing words of a screen they cannot see.
      record.refused = blocking.join(" ");
      // A floor that said nothing this loop can read — an unwired `component` door,
      // a screen refused before the gauntlet, a workspace wrapped without the seam
      // — leaves only the fact this hand does have. It is enough to act on, and
      // claiming a verdict nothing reached is what sent the loop back through a
      // call that could never succeed.
      const instruction = refusal(
        `${directory}/${APP_FILE}`,
        blocking.map((message) => ({ severity: "block" as const, message })),
      );
      return {
        saved: true,
        painted: false,
        note: instruction ?? "That save landed but did not reach the person's screen. Save a simpler screen.",
      };
    }
    // The data facts, only where there is a paint to read them off: they come from
    // the view the person is looking at, so no paint means nothing known.
    const queries = record.painted ? surface.queryOutcomes?.() ?? [] : [];
    const answer = {
      saved: true,
      // Omitted, never `false`, on an unwrapped workspace: this loop does not know.
      ...(record.painted === undefined ? {} : { painted: record.painted }),
      ...(queries.length === 0 ? {} : { data: queries.map(queryNote) }),
    };
    const note = "That save landed.";
    /**
     * THE CLOSING SAVE IS WHERE THE REVIEWER ANSWERS — into this very tool result.
     *
     * A save that painted and spoke in one breath is the end of the run, so the
     * screen is up and the words describing it are already in hand. The reviewer is
     * asked HERE and AWAITED here, and its findings ride back as part of the save's
     * own answer: the next step of THIS drive is then the repair, with the document
     * the model just wrote still in front of it. The alternative — hanging up and
     * starting a second drive — pays for the reviewer's latency all the same and
     * then buys a fresh drive that has to be handed the document back.
     *
     * Empty verdict, or a reviewer that could not reach one (`judgeScreen`
     * fail-opens to `undefined`), and the run hangs up exactly as before: from
     * INSIDE the call, before the result goes back, because the loop starts its
     * next step the moment a tool answers.
     *
     * ONE round, and `reviewed` is the whole of what bounds it: the repair patch is
     * itself a save that paints and speaks, and without the flag it would be judged
     * again, and again.
     */
    if (record.painted && spoken.trim() !== "") {
      const findings = reviewed
        ? undefined
        : await judgeScreen(surface, input.appId, `${directory}/${APP_FILE}`, input.request, input.viewport);
      reviewed = true;
      if (findings !== undefined) {
        described = spoken.trim();
        return { ...answer, note: `${note}\n\n${findings}` };
      }
      ended?.abort();
    }
    return { ...answer, note };
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
      return await serially(async () => await landApp(turn, content, decisions));
    },
  };

  const editApp: HarnessHand = {
    name: EDIT_APP_TOOL,
    description:
      "Change exact passages of the file you already saved: each edit's `find` goes, its `replace` takes "
      + "its place. Use it to fix errors rather than saving the whole file again — the rest of the screen "
      + "the person is looking at then stays exactly where it is. Send every edit you have in ONE call: "
      + "they are matched against the file as it stands and land together, all of them or none. Each "
      + "`find` must appear in that file exactly once, character for character. Lands and reports exactly "
      + "like a save.",
    inputSchema: {
      type: "object",
      properties: {
        edits: {
          type: "array",
          minItems: 1,
          description: "Every change to make, applied together in one save.",
          items: {
            type: "object",
            properties: {
              find: {
                type: "string",
                description:
                  "The text to replace, exactly as the file has it — enough of it to appear in only one place.",
              },
              replace: { type: "string", description: "What goes there instead." },
            },
            required: ["find", "replace"],
            additionalProperties: false,
          },
        },
        decisions: {
          type: "string",
          description: `Same decisions record as \`${SAVE_APP_TOOL}\` — it replaces this app's whole block.`,
        },
      },
      required: ["edits"],
      additionalProperties: false,
    },
    execute: async (args, turn) => {
      const { edits, decisions } = args as { edits: readonly Edit[]; decisions?: string };
      return await serially(async () => {
        const document = await turn.workspace.readFile(`${directory}/${APP_FILE}`).catch(() => undefined);
        if (document === undefined) {
          return { saved: false, note: `There is no file to edit yet — save the whole screen with ${SAVE_APP_TOOL} first.` };
        }
        const planned = editPlan(document, edits);
        if ("refusal" in planned) return { saved: false, note: planned.refusal };
        return await landApp(turn, planned.content, decisions);
      });
    },
  };

  const escalate: HarnessHand = {
    name: ESCALATE_TOOL,
    description:
      "Ask for this to be BUILT for real — a machine that installs packages, writes code and tests it. Use it "
      + "when assembling a screen out of this product's components genuinely cannot serve the ask. It spends "
      + "nothing and builds nothing by itself: the person is asked, and their yes is what starts the build. "
      + "Their own ask is the builder's brief — say only why assembly cannot serve it. This ends your turn.",
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
      // The whole of the hand: one line recorded. What it becomes — a standing
      // approval card, and a build only if the person says yes — is the front
      // door's business (`make-tool.ts`'s escalate arm), which is what keeps
      // this loop unable to spend a machine.
      record.escalated = why;
      // …and the turn ends here, the same way a closing save ends it. Recording
      // the line and returning left the drive taking further steps, still
      // offered `save_app` and `edit_app`, so a screen could be written and
      // painted for an app whose build is waiting on the person's yes.
      ended?.abort();
      return { asked: true };
    },
  };

  // The small loadout, resolved where the listings are: the assembly verbs by
  // name, plus the host's read tools so a query's real values can be learned when
  // a tool declares no shape. `vendo_make` is excluded by name — it is what called
  // this loop — and a mutating host tool is not an assembly tool. Names, not a
  // risk filter passed downward: the closed list stays a list, and the one place
  // that can decide "is this an assembly tool" is the one holding the listing.
  const offered = listings.filter((listing) => listing.name !== VENDO_MAKE_TOOL);
  /** Is this run EDITING? There is no mode flag and none is wanted: the app to
   *  open is the document at this app's own path, and its presence is the whole
   *  distinction — read here exactly as the edit hand reads it above. */
  const editing = await surface.workspace.readFile(`${directory}/${APP_FILE}`).then(() => true, () => false);
  // Withheld from BOTH halves, by NAME before any grade is consulted: the registry
  // grades every one of these `read` (`vendo-verbs.ts`'s `DESCRIPTORS`), so the
  // risk filter below is exactly how they kept coming back, and the complement
  // beneath it is where they would come back a second time as a button. See
  // `ASSEMBLY_TOOLS` for why this loop carries no `validate`, and `NEVER_WIRED`
  // for the rest.
  const withheld = editing ? NEVER_WIRED : [...NEVER_WIRED, ...EDIT_TOOLS];
  const callable = (listing: ToolListing): boolean =>
    !withheld.includes(listing.name)
    && (ASSEMBLY_TOOLS.includes(listing.name) || listing.risk === "read");
  const loadout: Array<string | HarnessHand> = offered.filter(callable).map((listing) => listing.name);
  // The other half of the same split, and the whole of the brief's tool section:
  // what a button may name and this loop may not call. Split ONCE, from one
  // predicate, so a tool can never be both equipped and described as un-callable —
  // the equipped ones arrive with their own schemas (`equipClosedLoadout`), and
  // saying them again in prose is the same tool twice. `withheld` comes off this
  // half as well, and that is what catches the machinery on the way through:
  // refusing to equip a verb drops it into the complement, and "this loop cannot
  // call it" is not the same claim as "hand the person a button for it".
  const wireable = offered.filter((listing) => !callable(listing) && !withheld.includes(listing.name));

  /** Every hand takes the words with it, exactly as a host call does below. */
  const acting = (hand: HarnessHand): HarnessHand => ({
    ...hand,
    execute: async (args, turn) => {
      acted();
      return await hand.execute(args, turn);
    },
  });
  loadout.push(acting(saveApp), acting(editApp));
  if (input.canBuild === true) loadout.push(acting(escalate));

  const turn: Turn<VendoHarnessOptions> = {
    messages: [{
      id: `screen_${input.appId}`,
      role: "user",
      parts: [{ type: "text", text: `${startingSource(input.source)}${input.request}` }],
    }],
    // The listings are read ONCE and handed back verbatim: a closed loadout has
    // nothing to discover, so re-reading them mid-run would be a second projection
    // of the same static menu.
    tools: {
      call: (name, args) => {
        acted();
        return surface.tools.call(name, args);
      },
      list: async () => listings,
    },
    skills: NO_SKILLS,
    workspace: surface.workspace,
    // `vendo()` thinks with the turn's `default` seat, and the loop it drives
    // HERE is the app-writing one — so the seat this agent runs on is what the
    // inner harness is handed as its default, wrapped so the write turn thinks
    // and the saves and patches after it do not (`seatByRole`).
    models: { ...surface.models, default: seatByRole(surface.models.apps) },
    state: runState(),
    options: {},
    signal: AbortSignal.any([surface.signal, stop.signal]),
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
  const harness = vendo({
    tools: loadout,
    maxSteps: SCREEN_STEPS,
    // The brief WINS over `turn.system`: it already folds the deployment's prompt
    // in as its first section, so letting the turn's copy through would say it
    // twice.
    system: () => screenBrief(input, wireable),
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
    // The budget is the drive's LAST word, not a line in the brief. The repair
    // round runs on `REPAIR_STEPS` rather than the whole assembly budget, and a
    // number that changes between drives is a number the brief cannot hold: the
    // brief heads a cached prefix of some sixteen thousand tokens, so saying `3`
    // there instead of `10` re-uploaded every byte of it. Behind the history it
    // costs one sentence.
    const steps = options.maxSteps ?? SCREEN_STEPS;
    const budget = {
      id: `budget_${input.appId}`,
      role: "user" as const,
      parts: [{
        type: "text" as const,
        text: `\`${steps}\` steps is this round's whole budget.`,
      }],
    };
    // Each drive gets its own hang-up, and its own words: what the model said on
    // the drive before this one is not this drive's receipt, and a save here that
    // says nothing must not inherit it (`landApp` reads both).
    ended = new AbortController();
    closing = "";
    spoken = "";
    for await (const event of harness.run({
      ...turn,
      messages: [...messages, budget],
      options,
      // The TURN's own hang-up, plus this drive's. Composed rather than
      // re-listed: the turn's signal already carries the run's stop switch (a
      // deployment that cannot check screens ends the drive), and spelling out
      // `surface.signal` here instead dropped that switch on the floor — the
      // hand aborted and the loop kept paying for steps.
      signal: AbortSignal.any([turn.signal, ended.signal]),
    })) {
      if (event.type === "error") failure ??= event.message;
      if (event.type === "text") closing += event.delta;
    }
  };
  await drive(turn.messages);

  if (surface.signal.aborted) return { kind: "unavailable", why: "the caller hung up" };
  // A deployment that cannot check screens wins over everything below it: the
  // bytes landed, so `assembled` is true, but nothing was ever read and nothing
  // painted. The floor's own sentence is the answer, and it names a fix — for the
  // host, which is the only hand that can apply it.
  if (record.blocked !== undefined) return { kind: "unavailable", why: record.blocked };
  // Escalation wins over a partial paint: the builder is finishing this app, and
  // saying "ready" over a half-assembled document would be the lie §4.5 exists
  // to avoid. `status: "building"` is the honest receipt, and the front door
  // stamps it.
  if (record.escalated !== undefined) return { kind: "escalate", why: record.escalated };
  // A model failure AFTER a screen already painted is not a failed screen — but
  // `assembled` alone is not that screen. It says bytes landed ONCE; `painted`
  // says whether the LAST save reached the person, and a run that ends on a
  // refused save leaves them looking at whatever an earlier one left there. Live:
  // a multi-save build whose first save cleared the floor and whose last did not
  // answered "Your card is live!" over a stale card, because a row existed and
  // this gate never asked about the paint. `undefined` is neither answer — an
  // unwrapped workspace has no paint to judge — so only a `false` refuses.
  if (record.assembled && record.painted !== false) {
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
     * to leave it rather than take it away. ANY finding buys that round, warnings
     * included (`judgeScreen`): the ask rules and the host's own design rules are
     * graded `warn` for a person's eye, and skipping them here left them costing a
     * model call and changing nothing.
     *
     * `record.painted` gates it here too, for the one case the outcome gate above
     * lets through unjudged: an unwrapped workspace, which has no paint and no row
     * for the reviewer's row-scoped door to find, so asking would spend the
     * person's time on a door that can only answer `not-found`.
     *
     * WHEN it asks is the save's business, not this line's: a run whose last save
     * carried the closing words was judged AT that paint and read the verdict inside
     * the save's own answer (`landApp`), so its repair is the next step of the drive
     * that wrote the screen. This is the FALLBACK — a run that ended without a
     * verdict, because it never spoke beside a save — and the only thing that still
     * needs a drive of its own.
     */
    const appPath = `${directory}/${APP_FILE}`;
    const instruction = reviewed || !record.painted
      ? undefined
      : await judgeScreen(surface, input.appId, appPath, input.request, input.viewport);
    // The words the run ended on: what it said after its last action, or — now that
    // a save and the sentence about it ride one turn — what it said in the same
    // breath as that action.
    const words = (): string => (closing.trim() === "" ? spoken : closing).trim();
    /** The paint verdict AS IT STANDS — read through a call on purpose. The gate
     *  above narrowed `record.painted` to "not false" for the rest of this block,
     *  and the repair round below is the one thing that can still make it false. */
    const painted = (): boolean | undefined => record.painted;
    /** What describes the screen the person is looking at, taken from before the
     *  verdict on either route to a repair round: `described` where the closing
     *  save carried the findings back and the same drive went on to repair, and
     *  this drive's own words where it ended unjudged and the fallback below is
     *  what asks. A receipt is about the screen, not about the last thing the
     *  model typed. */
    const say = described ?? words();
    let title = record.title;
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
            : `${instruction}\n\nThis is the document you saved:\n${saved}`,
        }],
      }], { maxSteps: REPAIR_STEPS });
      /**
       * A REPAIR THE FLOOR REFUSED DID NOT HAPPEN — so it does not get to NAME the
       * screen either.
       *
       * Its bytes landed and nothing painted, which leaves the person looking at
       * the screen from before the round, while its `record.title` is the name of a
       * screen nobody ever saw. The screen itself STANDS — taking away a painted
       * screen because a patch on it failed is the one thing worse than an
       * unrepaired screen — so what a refused round costs it is only the new name.
       */
      if (painted() !== false) title = record.title;
    }
    return {
      kind: "assembled",
      ...(title === undefined ? {} : { title }),
      ...(record.decisions === undefined ? {} : { decisions: record.decisions }),
      // The run's own closing words, or nothing. Never a sentence this file wrote:
      // the front door is the one place that has a fallback, and it is the shipped
      // one (`make-tool.ts`).
      ...(say === "" ? {} : { say }),
    };
  }
  // The floor's own sentences first: they name what is wrong with the screen the
  // person asked for, which no sentence about the loop can. Last comes the run's
  // own shape, and a run that never saved is not a screen that failed to render:
  // saying so sent people looking for a broken screen that was never written.
  // WHY the model did not save is not knowable here — that is the model's
  // behaviour, not the seam's state — so this says only what happened.
  return {
    kind: "unavailable",
    why: record.refused || failure
      || (record.assembled ? "assembly produced nothing that renders" : "this run never saved a screen"),
  };
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
  /**
   * The app's stored `app.tsx` — what the checkout below projects into the
   * workspace when the workspace has none.
   *
   * Composition fills it from `AppsRuntime.get`, exactly as it fills `render` and
   * `remember`: this file depends on no store and must never reach for one. The
   * reader that cannot do without it is the ✦ remix — `seed.from` writes the
   * splitter's ported source to the ROW, and this loop can only edit code it can
   * SEE in the workspace. Unfilled — or answering `undefined`, which is what
   * composition does for every app that is NOT a remix — an edit starts from
   * whatever the workspace already holds, which is exactly today's behaviour.
   */
  storedScreen?: (appId: AppId, ctx: RunContext) => Promise<string | undefined>;
  /**
   * The source THIS run must start from, replacing whatever the workspace holds
   * — `AppsRuntime.takeReplaySource`, published by a re-seed for its own replay
   * and gone once read.
   *
   * Deliberately NOT folded into `storedScreen`: that one fills an EMPTY
   * workspace and must never overwrite a save, while this one exists precisely
   * to overwrite. Keeping them two slots is what makes the overwrite
   * unreachable from an ordinary edit — an ordinary edit publishes nothing, so
   * there is nothing for it to take.
   */
  replayFrom?: (appId: AppId) => string | undefined;
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
   * Called only for an `assembled` run — the only answer that carries decisions
   * at all. `assembled` means the BYTES landed, which is not the same thing as a
   * row: a paint is what creates one, so a run whose saves the floor refused has
   * nowhere to put its memory, and that `not-found` is an expected state rather
   * than a fault (`commitSource` reports its half the same way). Unfilled, or
   * throwing, and the run's decisions are simply not recorded: a lost memory
   * write is never worth failing a screen the person can already see.
   */
  remember?: (appId: AppId, decisions: string, ctx: RunContext) => Promise<void>;
  /**
   * Is there a builder behind an escalation — `AppBuilder.available`, handed
   * over by the composition that fills BOTH slots.
   *
   * Availability by construction, exactly as `servedProxyPath`'s presence used
   * to say it (compose-apps.ts): the loop is offered the door out only where a
   * box could really be claimed after the person's yes. Unfilled reads as no,
   * which is what a deployment with no sandbox is.
   */
  canBuild?: () => boolean;
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
      // THE CHECKOUT — contract §3.2's law applied on the way IN: the row is the
      // truth and the workspace is a working copy of it. The ✦ gesture writes a
      // remix's PORTED `app.tsx` straight to the row (`seed.from`), so without
      // this the loop's first `edit_app` finds no file and rewrites the component
      // from nothing — the one thing a fork exists not to do.
      //
      // Through the UNWRAPPED workspace on purpose: the floor already graded
      // these bytes before the row stored them, so painting them again here would
      // buy nothing and cost a second gauntlet on every edit. It never overwrites
      // — a file already here belongs to a save, and a save is newer than the row.
      const checkout = `${appDirectory(request.appId)}/${APP_FILE}`;
      // A RE-SEED replays the recorded wish onto the host's NEW port, so its
      // starting point REPLACES the workspace copy — the person's old screen is
      // what it is replacing. Nothing has been written to the row: this run's own
      // save is the single landing, so a replay that never saves leaves the
      // stored screen untouched. Only a re-seed publishes one.
      let start = deps.replayFrom?.(request.appId);
      // Otherwise the app's own stored screen — a REMIX's and nothing else
      // (`storedScreen`, compose-apps.ts). Read whether or not the workspace
      // already holds a copy, because this is ALSO what goes in front of the
      // model ({@link startingSource}) and the loop cannot read the workspace
      // itself. Asking only when the workspace was empty meant a remix's SECOND
      // edit arrived with no code at all in front of it, and an ask with nothing
      // to change is answered out of the catalog — the one thing a fork exists
      // not to do, and what a live session's fourth attempt did (2026-08-18),
      // taking the first wish's edit with it.
      const held = start === undefined && await base.exists(checkout);
      start ??= await deps.storedScreen?.(request.appId, ctx);
      // Blank is not a screen — `open()` reads it the same way — and an empty
      // file would leave `edit_app` editing nothing, which is worse than none.
      //
      // STAGED, NEVER COMMITTED — DO NOT ADD A `commit()` HERE. It looks like a
      // missing half, and it is not: the staging IS the mechanism.
      //
      // A staged write is visible to this run's own reads and to nothing else
      // (`workspace-fs.ts:91`, and `readFile` at `:276`), so a run that saves
      // nothing lands nothing — the row keeps the person's screen and so does the
      // workspace. Whatever the run DOES save commits this along with it, which is
      // the only moment either copy should move.
      //
      // Committing here instead lands the checked-out source whether or not the
      // run ever used it, and that is DATA LOSS with a green test in front of it:
      // a failed re-seed leaves the host's new port sitting in the workspace, the
      // next ordinary edit opens that instead of the person's screen, and saves it
      // over the top. The row-level guarantee still passes the whole time, because
      // the loss happens a turn later. Proven: re-add the commit and
      // `remix-port-seed.e2e.test.ts`'s re-seed guarantee goes red on the
      // workspace half.
      //
      // Never over a file the workspace already `held`: that one belongs to a
      // save, and a save is newer than the row. Showing it is not writing it.
      //
      // So a `held` run is SHOWN the row while its hands edit the workspace, and
      // §3.2 is what makes that the right way round: a landed save wrote both, so
      // they agree, and where they do not the ROW is the truth — it is the screen
      // the person is actually looking at. The way they part is a save the floor
      // refused, which reaches the workspace (`persistSource`) but never the row.
      // Showing the workspace there would hand the model bytes the floor has
      // already rejected; showing the row costs at most a missed `edit_app`, and
      // a miss is reported (#1535) over a screen that still stands.
      const starting = start !== undefined && start.trim() !== "" ? start : undefined;
      if (starting !== undefined && !held) await base.writeFile(checkout, starting);
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
      let refused: ScreenRefusal = { blocking: [] };
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
              refused = result.ok ? { blocking: [] } : result;
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
          ...(starting === undefined ? {} : { source: starting }),
          ...(deps.canBuild?.() === true ? { canBuild: true } : {}),
        },
      );
      if (result.kind !== "assembled") return result;
      if (result.decisions !== undefined) {
        await deps.remember?.(request.appId, result.decisions, ctx).catch((error: unknown) => {
          // NO ROW YET IS NOT A FAILURE, exactly as `commitSource` reads it: a
          // paint is what creates the row, so a run whose every save was refused
          // has none and its decisions have nowhere to land. Warning about it
          // sends an operator hunting for a broken memory door behind an expected
          // state; everything else IS a write that should have happened.
          if (isVendoError(error) && error.code === "not-found") {
            log({
              code: "vendo.screen-agent-decisions-no-row",
              level: "info",
              message: `[vendo] ${request.appId} has no row yet, so this run's decisions wait for the save that paints`,
            });
            return;
          }
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
