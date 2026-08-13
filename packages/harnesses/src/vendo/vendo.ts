/**
 * `vendo()` — the default harness. NOT a second loop: it drives `startTurn` from
 * ./loop.ts — the one loop this package has, shared with its hired subagents and
 * the screen agent — so every rail in it (the step cap, `buildFailedStop`, the
 * history window, the cache breakpoints, the step-limit notice) is shared rather
 * than re-derived.
 *
 * What the lift changes, and only this:
 * - tools execute through `turn.tools.call()`, which runs the SHIPPED guarded-call
 *   path — so the guard, the audit row, the view channel and the transcript mirror
 *   are not this file's business and cannot be forgotten;
 * - approvals are §1.4's wait-or-fail inside `call()`, so there is no
 *   `needsApproval` hook here and no second consent path;
 * - output is the closed `HarnessEvent` vocabulary instead of wire chunks, so this
 *   file contains no persistence and no wire code;
 * - it hires its own subagents for big jobs. Weight and staffing are the harness's
 *   business — that is the dividing line, and orchestration is thinking.
 */
import { z } from "zod";
import { modelToolDescription, type Harness, type Json, type Turn } from "@vendoai/core";
import { readCompactionState, writeCompactionState, type CompactionState } from "./compaction.js";
import { startTurn, type TurnCompaction, type TurnContext } from "./loop.js";
import { contextWindowTokens, rememberResolvedModelId, resolvedModelId } from "./model-windows.js";
import { isContextOverflow } from "./overflow.js";
import {
  computeInitialLoadout,
  FIND_TOOLS_DESCRIPTION,
  FIND_TOOLS_TOOL_NAME,
  alwaysActivePredicate,
  searchListings,
  type VendoToolSearchConfig,
} from "./tool-search.js";
import { wireErrorMessage } from "../wire-error.js";
import { emitWorkbench, type WorkbenchAgent } from "../workbench.js";
import { harnessAdapters } from "../harness-sandbox.js";
import type { UsageTotals } from "../runtime.js";
import {
  jsonSchema,
  tool,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { defineHarness } from "../define.js";

/** How many messages a hired subagent may exchange before it must report back.
 *  Bounded so a runaway helper costs a receipt, not a turn. */
const SUBAGENT_MAX_STEPS = 12;

const SPECIALIST_SYSTEM =
  "You are a specialist hired for one job. Do it with the tools you have, then report back in "
  + "at most three sentences. Your reply is read by another agent, not by a person.";

const HIRE_SUBAGENT = "hire_subagent";

/**
 * What a specialist is handed instead of the skill it was hired with, when that
 * skill could not be loaded. Written for the SPECIALIST, not the user: like
 * `SPECIALIST_SYSTEM`, this text is read by another agent.
 *
 * A degraded hire beats no hire (#899), but only if what it is told is TRUE — the
 * specialist acts on this and the transcript keeps it. Nothing here can tell an
 * invented name from a file that will not read (`load()` throws the same plain
 * `Error` for both), so the notice does not pretend to: it names both
 * possibilities, which is the whole of what is actually known.
 */
const unloadableSkillNotice = (name: string): string =>
  `The "${name}" skill could not be loaded — it may not exist, or this deployment's `
  + `skills may themselves be unreadable — so the instructions it was to give you are not `
  + `in this brief. Do the job below with the tools you have, and say what you could not cover.`;

/**
 * The per-turn knobs — the TYPE is the whole declaration.
 *
 * There was a `Harness.optionsSchema` here too, restating these knobs as zod. It
 * was never parsed: nothing in the stack validates a harness's options schema,
 * and the one path that could have (`HarnessTurns.stream` → `runtime.run`) is
 * typed `<never>` and forwards no options at all. So the schema was a second,
 * unenforced copy of this interface, and a caller reaching `Turn.options` is
 * `runtime.run({ options })` — typed, in-process, and already checked by tsc.
 * Where a value's range genuinely matters the check lives at the function that
 * needs it ({@link contextWindowTokens}), which is the only place either the
 * per-turn or the deployment door was ever checked.
 */
export interface VendoHarnessOptions {
  model?: LanguageModel;
  maxSteps?: number;
  /** The shipped loop's context knobs, per turn. They were declared on the loop
   *  and on `createAgent` but not here, and this file passed `maxSteps` alone —
   *  so a deployment on the default harness (which is every deployment whose
   *  store can serve harness turns) could not reach the history window or the
   *  token budget at all. */
  historyWindow?: number;
  contextTokenBudget?: number;
  maxOutputTokens?: number;
  maxRetries?: number;
  /** Override the window this seat is assumed to have. The BYO escape for a
   *  model {@link contextWindowTokens}'s table cannot name. */
  contextWindowTokens?: number;
}

/** The knobs a per-turn option may override, and the deployment defaults they
 *  override. One list, so a new knob cannot reach one half and not the other. */
const CONTEXT_KNOBS = [
  "maxSteps",
  "historyWindow",
  "contextTokenBudget",
  "maxOutputTokens",
  "maxRetries",
  "contextWindowTokens",
] as const;

// …and that promise ENFORCED rather than restated, in the `config-keys.ts`
// pattern: the assertions live in a source file because tsconfig excludes tests
// from typecheck, so an assertion in a test is compiled by nothing.
//
// Every listed knob has both doors…
const _knobsHaveBothDoors: ReadonlyArray<keyof VendoHarnessOptions & keyof VendoHarnessDeps>
  = CONTEXT_KNOBS;
void _knobsHaveBothDoors;
// …and every knob the shipped loop takes is listed, or this resolves to
// something other than `never` and fails right here, by name. One direction
// only: `contextWindowTokens` rides the list without being a `TurnContext`
// member, because it configures COMPACTION (see the destructure in `run`).
type AssertNever<T extends never> = T;
type _NoKnobLeftBehind = AssertNever<Exclude<keyof TurnContext, (typeof CONTEXT_KNOBS)[number]>>;

export interface VendoHarnessDeps {
  /**
   * An explicit system prompt, for a host driving this harness outside our
   * composition. Set, it WINS over `turn.system`; unset — the normal case, and
   * what `harness: vendo()` builds — the deployment's assembled prompt arrives on
   * the turn instead. It cannot arrive here: this value is constructed once at
   * boot, and the prompt is venue-gated and carries the guard's directions, so it
   * needs the turn's `RunContext`.
   */
  system?: string | (() => string | undefined | Promise<string | undefined>);
  maxSteps?: number;
  /** The deployment's defaults for the loop's context knobs; a per-turn option of
   *  the same name wins. `maxSteps` stays above for back-compat and reads the
   *  same either way. */
  historyWindow?: number;
  contextTokenBudget?: number;
  maxOutputTokens?: number;
  /** How many times the SDK re-issues a failed provider call ({@link
   *  DEFAULT_MAX_RETRIES}); `0` spends nothing. */
  maxRetries?: number;
  /** The window this deployment's seat is assumed to have, when the shipped
   *  table is wrong about it. Q1a: this lives on the harness and nowhere else —
   *  it is a fact about a model, not a product decision a host composes. */
  contextWindowTokens?: number;
  /**
   * vendo()'s tool-search strategy: the loadout cap and the `find_tools` hand
   * ({@link VendoToolSearchConfig}). Composition passes it when it constructs
   * the default harness; a host-constructed `vendo()` receives it through the
   * composed adapter slot instead, like `claudeCode()`'s sandbox. Unset both
   * ways = every projected tool offered and no search — the strategy is the
   * brain's, so a brain given none has none.
   */
  toolSearch?: VendoToolSearchConfig;
  /**
   * The CLOSED toolbox. Set, the equipped set is EXACTLY this list: a string
   * equips that registry tool (guarded, via `turn.tools.call`, same as today); a
   * {@link HarnessHand} is the harness's own hand, invisible to every other
   * consumer. No discovery rail (`find_tools` is not mounted — a fixed loadout has
   * nothing to discover), no `vendo_*` always-active exemption (the list is
   * total), no `hire_subagent` unless named. Unset = today's behaviour, unchanged.
   *
   * This is what lets a specialist BE `vendo()` plus configuration rather than a
   * second copy of the loop: the step cap, the seat resolution, `wireErrorMessage`
   * and the system precedence are the ones above, not a fork of them.
   */
  tools?: readonly (string | HarnessHand)[];
}

/**
 * A tool the harness itself provides — the other half of a closed loadout.
 *
 * `execute` receives the TURN, which is what lets a hand be declared once at boot
 * (where a `Harness` value is built, with no run in sight) while its effects are
 * per-run: `turn.workspace` is this run's files and `turn.state` is this run's
 * scratch. A hand never reaches the registry, so nothing else can discover it and
 * the guard has nothing to decide about it — a hand that touches host data does it
 * by calling `turn.tools.call` like anyone else.
 */
export interface HarnessHand {
  /** What the model calls it. Never `vendo_`-prefixed: those names are the
   *  product's, and the loadout rail treats them as always-active. */
  name: string;
  description: string;
  /** JSON Schema, the same dialect a `ToolListing.inputSchema` carries. */
  inputSchema: Record<string, unknown>;
  execute(input: Json, turn: Turn<unknown>): Promise<Json>;
}

/** A tool with no declared input still needs a schema the provider will accept. */
const NO_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

/**
 * Refresh the live toolset from `turn.tools.list()` — the ONE discovery surface
 * (contract §1.1: "currently-equipped tools, post-curation"). Returns the names
 * the model may pick this step.
 *
 * Two things make this the whole discovery rail. The set is re-read rather than
 * captured once, so a tool searched in mid-turn through `find_tools` is offered on
 * the next step; and `tools` is MUTATED in place rather than rebuilt, because
 * `streamText` re-reads the same object each step, so a newly listed tool is
 * genuinely callable without restarting the turn.
 */
async function refreshEquipped(
  turn: Turn<unknown>,
  tools: ToolSet,
  /** Re-read the listing after every call. A `find_tools` call is what changes
   *  the equipped set, and `prepareStep` reads the snapshot synchronously, so the
   *  re-read has to happen while we are still inside the call that changed it. */
  afterCall: () => Promise<void>,
): Promise<string[]> {
  const listings = await turn.tools.list();
  for (const listing of listings) {
    tools[listing.name] ??= tool({
      // Title-first, so the model has a human label to speak (§3): its own
      // refusals and explanations are user-visible surfaces, and `title` is
      // otherwise the one field of the listing this harness never reads.
      description: modelToolDescription(listing),
      inputSchema: jsonSchema((listing.inputSchema ?? NO_INPUT_SCHEMA) as Parameters<typeof jsonSchema>[0]),
      // The whole safety story in one line: the guard, the audit row, the view
      // channel, the transcript mirror and §1.4's approval block all live behind
      // `call()`.
      execute: async (input: unknown) => {
        const result = await turn.tools.call(listing.name, input as Json);
        await afterCall();
        return result;
      },
    });
  }
  return listings.map((listing) => listing.name);
}

/**
 * Mount a CLOSED loadout: this list, resolved once, and nothing else.
 *
 * The listing is read one time and never re-read — a fixed loadout has nothing to
 * discover, so `find_tools` is not mounted and there is no `afterCall` refresh. A
 * name the listing does not carry is simply NOT OFFERED: the list is written at
 * boot against a listing that legitimately varies per deployment (an optional
 * host tool, a pack that is not installed), so an absence is a fact about the
 * deployment rather than a fault in the harness — and the model is never told
 * about a tool it could not have called anyway.
 */
async function equipClosedLoadout(
  turn: Turn<unknown>,
  tools: ToolSet,
  loadout: readonly (string | HarnessHand)[],
  hireSubagent: ToolSet[string],
): Promise<string[]> {
  const listings = new Map((await turn.tools.list()).map((listing) => [listing.name, listing]));
  for (const entry of loadout) {
    if (typeof entry !== "string") {
      tools[entry.name] = tool({
        description: entry.description,
        inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
        execute: async (input: unknown) => await entry.execute(input as Json, turn),
      });
      continue;
    }
    if (entry === HIRE_SUBAGENT) {
      tools[entry] = hireSubagent;
      continue;
    }
    const listing = listings.get(entry);
    if (listing === undefined) continue;
    tools[entry] = tool({
      description: modelToolDescription(listing),
      inputSchema: jsonSchema((listing.inputSchema ?? NO_INPUT_SCHEMA) as Parameters<typeof jsonSchema>[0]),
      // The same one line as the open loadout: the guard, the audit row, the view
      // channel, the transcript mirror and §1.4's approval block live behind
      // `call()`, closed list or not.
      execute: async (input: unknown) => await turn.tools.call(listing.name, input as Json),
    });
  }
  return Object.keys(tools);
}

interface SubagentReport {
  summary: string;
  /** Every token a hired specialist spent. Unmetered subagents are the bulk of a
   *  build turn's inference, so this is not optional bookkeeping — and the FULL
   *  shape, cache split and model included, because the hire's own audit row is
   *  the only row that carries them. */
  usage: UsageTotals;
}

/** The resolved id of the seat that spent the tokens: what the PROVIDER reported
 *  for it (the same record the window table reads), else the seat's own id. A
 *  lazy seat answers `vendo-env` for its own id — a family, not a model — and
 *  usage is what hosts meter on. */
const modelIdOf = (model: LanguageModel): string =>
  typeof model === "string" ? model : resolvedModelId(model) ?? model.modelId;

/** One usage figure set from an `ai` totals block, in `UsageTotals` shape. */
function usageOf(usage: LanguageModelUsage, model: LanguageModel): UsageTotals {
  const { cacheReadTokens, cacheWriteTokens } = usage.inputTokenDetails;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    // The seat this loop actually thought with, so the row prices without
    // anyone asking composition which seat it chose.
    model: modelIdOf(model),
  };
}

/**
 * The head of a brief for a hire that named a skill: the full SKILL.md body — the
 * job description, and the point of hiring rather than inlining — or the notice
 * that says it is not coming.
 *
 * ONE call and one fallback, because a hire has one job. Whatever went wrong, the
 * answer is the same: load nothing, say so in the brief, run the specialist. So
 * there is nothing to classify, and nothing else on the mount is ever opened —
 * `createTurnSkills.list()` reads every mounted SKILL.md to describe it, so
 * consulting it would let one unreadable file anywhere take down a hire whose own
 * skill is perfectly fine.
 */
async function skillHead(turn: Turn<unknown>, skill: string): Promise<string> {
  try {
    return `${await turn.skills.load(skill)}\n\n---\n\n`;
  } catch {
    return `${unloadableSkillNotice(skill)}\n\n`;
  }
}

/**
 * A hired subagent: a fresh, blinkered loop with the same hands and the same
 * guard, whose OWN words never leave this function. The resident keeps only the
 * receipt — its private context, not a wire artifact, so the one-assistant law
 * holds without a transcript-only channel (§1.5's routing table has none).
 */
async function runSubagent(
  turn: Turn<unknown>,
  model: LanguageModel,
  input: { instructions: string; skill?: string },
  /** Already the resident's toolset minus the hiring tool — depth-1 lock #1. */
  tools: ToolSet,
  /** The loadout the specialist may PICK from, hiring filtered out — lock #2. */
  equipped: readonly string[],
  /** The resident's window, minus its state: a hire has no next turn, so there
   *  is nothing for it to remember and nothing of the thread's for it to spend. */
  compaction: TurnCompaction,
): Promise<SubagentReport> {
  const { skill } = input;
  const brief = skill === undefined
    ? input.instructions
    : `${await skillHead(turn, skill)}${input.instructions}`;
  // THE shipped loop, for the hire as well: every rail `startTurn` owns reaches
  // the specialist too, so it cannot drift from the resident on any of them.
  const loop = await startTurn({
    model,
    system: SPECIALIST_SYSTEM,
    messages: [{ id: "hire-brief", role: "user", parts: [{ type: "text", text: brief }] }],
    tools,
    // The specialist picks only from the hands it was given at hire time.
    activeTools: () => [...equipped],
    context: { maxSteps: SUBAGENT_MAX_STEPS },
    compaction,
    signal: turn.signal,
    turnId: turn.turnId,
    // A hire shares the resident's turn, so it shares its workbench channel; the
    // tag is the only thing that tells the two loops apart on it.
    workbenchAgent: "subagent",
  });
  const [text, usage, steps] = await Promise.all([
    loop.result.text,
    loop.result.totalUsage,
    loop.result.steps,
  ]);
  const summary = text.trim() || "The specialist finished without a summary.";
  emitWorkbench(turn.turnId, "subagent", {
    kind: "subagent",
    label: skill ?? input.instructions.slice(0, 60),
    steps: steps.length,
    maxSteps: SUBAGENT_MAX_STEPS,
    report: summary,
  });
  return { summary, usage: usageOf(usage, model) };
}

export function vendo(deps: VendoHarnessDeps = {}): Harness<VendoHarnessOptions> {
  const harness: Harness<VendoHarnessOptions> = defineHarness<VendoHarnessOptions>({
    name: "vendo",
    // Machine-less by design: in-process bash over the workspace is enough
    // (architecture §4, "Hands vary").
    async *run(turn) {
      // A caller that hung up before the turn started gets no model call at all.
      if (turn.signal.aborted) return;

      const model = turn.options?.model ?? turn.models.default;
      // Seats are required only where a harness reads them (contract §4,
      // relaxed) — and THIS harness reads `default`, so a turn without it is
      // the caller's composition bug, named loudly rather than limped past.
      if (model === undefined) {
        throw new Error("vendo() thinks with `turn.models.default`, and this turn carries no default seat");
      }
      const resolved: Partial<Record<(typeof CONTEXT_KNOBS)[number], number>> = {};
      for (const knob of CONTEXT_KNOBS) {
        const value = turn.options?.[knob] ?? deps[knob];
        if (value !== undefined) resolved[knob] = value;
      }
      // The window is not one of the loop's `TurnContext` knobs — it configures
      // COMPACTION, which is its own shape. It rides the same resolution list
      // anyway, so a per-turn option and a deployment default cannot disagree
      // about which one wins for this knob and not for its neighbours.
      const { contextWindowTokens: windowOverride, ...context } = resolved;
      // What the thread already knows about its own size. An unreadable or
      // foreign slot reads as no state, which costs one un-compacted turn.
      const stored = readCompactionState(turn.state.get());
      // …and what it searched in on earlier turns (the loadout memory). Read off
      // `stored`, not the boundary-checked `carried` below: a stale summary
      // boundary says nothing about which tools the thread loaded.
      const loaded = new Set(stored?.loadedTools ?? []);
      // The brain's strategy config: construction wins; the composed adapter
      // slot (the same drawer `claudeCode()`'s sandbox rides) fills it for a
      // host-constructed vendo().
      const searchCfg = (deps.toolSearch
        ?? harnessAdapters(harness).toolSearch) as VendoToolSearchConfig | undefined;
      // Exemption from loadout gating is config-declared (plus the harness's own
      // capability-miss hand) — the loop carries no product tool names.
      const isAlwaysActive = alwaysActivePredicate(searchCfg);
      // …and a slot the thread has OUTGROWN reads as no state too. §1.3 clears
      // the slot for an arbitrary edit and keeps it for a rewind, because a
      // harness with a native session rewinds that session itself. This one
      // cannot: the summary is the thread's only account of a band that has just
      // stopped existing, and the update skeleton's standing order is PRESERVE —
      // so a fact from a branch the user abandoned would be copied forward for
      // as long as the thread lives, and answered from. Dropping it costs one
      // extra compaction.
      const boundary = stored?.boundaryMessageId;
      const carried = boundary !== undefined && !turn.messages.some((message) => message.id === boundary)
        ? undefined
        : stored;
      const compaction: TurnCompaction = {
        model,
        contextWindowTokens: contextWindowTokens(model, windowOverride),
        ...(carried === undefined ? {} : { state: carried }),
      };
      const system =
        (typeof deps.system === "function" ? await deps.system() : deps.system)
        ?? turn.system
        ?? "";

      // The LIVE surface the model picks from, and the snapshot `prepareStep`
      // reads each step. `turn.tools.list()` is the only source for both: it is
      // the curated, equipped set, and re-reading it is how a tool searched in
      // through `find_tools` becomes callable in the SAME turn. One object, never
      // a copy — `streamText` re-reads it per step, so a copy would freeze the
      // toolset at step one and strand every discovery. (A closed loadout has
      // nothing to discover, so it fills the same object once and stops.)
      const residentTools: ToolSet = {};
      let equipped: string[] = [];
      // Which loop this drive is, for the workbench only. A CLOSED loadout is the
      // screen agent's shape (`vendo({ tools, maxSteps })` — packages/vendo's
      // screen-agent.ts) and an open one is the thread's resident thinker; the
      // two share a turn and a channel, so something has to name them apart.
      const workbenchAgent: WorkbenchAgent = deps.tools === undefined ? "resident" : "screen";
      /** Each helper's spend, yielded as its own `usage` event after the stream
       *  drains — the one metering channel every brain has. No receipt path:
       *  per-hire audit rows are gone (Option 1, 2026-08-09), exactly matching
       *  how claude-code's box reports (one blended usage stream). */
      const hiredUsage: UsageTotals[] = [];
      const hireSubagent = tool({
        description:
          "Hire a specialist for one big job (building or editing an app, a long research pass). "
          + "Name a skill to give it the full instructions. It reports back a short summary.",
        inputSchema: z.object({
          instructions: z.string().describe("What the specialist should accomplish."),
          skill: z.string().optional().describe("A skill name from your skill list."),
        }),
        execute: async (input) => {
          let report: SubagentReport;
          try {
            // The specialist gets the same hands as the resident has RIGHT NOW —
            // searched-in tools included — minus the hiring tool, so depth is
            // bounded at one and a helper cannot spawn a tree.
            const { [HIRE_SUBAGENT]: _hiring, ...hands } = residentTools;
            // A snapshot, not the live variable: the hands are frozen at hire
            // time, so the loadout has to be too or it could name a tool the
            // specialist was never handed.
            const loadout = equipped.filter((name) => name !== HIRE_SUBAGENT);
            report = await runSubagent(turn, model, input, hands, loadout, {
              ...compaction,
              state: undefined,
            });
          } catch (error) {
            // A failed hire is one tool result the resident can react to — never
            // the turn's death.
            console.error("[vendo] harness: subagent failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return { error: "The specialist could not be reached for that job." };
          }
          // The helper's spend joins the turn's own metering through the one
          // channel every brain has: stashed here, yielded as a `usage` event
          // after the stream drains, where the runtime's `addUsage` folds it
          // into the run row.
          hiredUsage.push(report.usage);
          return { summary: report.summary };
        },
      });

      // The closed list is TOTAL: what it names is what the model gets, hiring
      // included only if it is named. The open path keeps the discovery rail — the
      // listing re-read after every call — and hires by default.
      let activeToolNames: () => string[];
      /** What the model may pick right now, and what it may not — a fact only
       *  this file holds, because the loadout is the brain's own strategy. */
      const emitLoadout = (): void => {
        const active = activeToolNames();
        emitWorkbench(turn.turnId, workbenchAgent, {
          kind: "loadout",
          active,
          searchedIn: [...loaded],
          alwaysActive: active.filter(isAlwaysActive),
          withheldCount: equipped.filter((name) => !active.includes(name)).length,
        });
      };
      if (deps.tools === undefined) {
        const refresh = async (): Promise<void> => {
          equipped = await refreshEquipped(turn, residentTools, refresh);
        };
        await refresh();
        residentTools[HIRE_SUBAGENT] = hireSubagent;
        if (searchCfg !== undefined) {
          // The starting toolbelt, computed once per turn over the projected
          // listing; everything past it stays reachable through `find_tools`.
          const initial = computeInitialLoadout(await turn.tools.list(), searchCfg);
          residentTools[FIND_TOOLS_TOOL_NAME] = tool({
            description: FIND_TOOLS_DESCRIPTION,
            inputSchema: z.object({
              query: z.string().min(1).max(200).describe("What you need to do."),
              limit: z.number().int().min(1).max(25).optional(),
            }),
            execute: async ({ query, limit }) => {
              const listings = await turn.tools.list();
              let matches: readonly { name: string; description: string; score: number }[];
              try {
                matches = searchCfg.search !== undefined
                  ? await searchCfg.search(query, limit === undefined ? undefined : { limit })
                  : searchListings(listings, query, limit);
              } catch {
                // A broken registry seam degrades to local scoring, never to a
                // dead search.
                matches = searchListings(listings, query, limit);
              }
              for (const match of matches) loaded.add(match.name);
              // The registry may have lazily expanded a toolkit during the
              // search; re-reading the listing NOW is what makes a found tool
              // callable on the very next step.
              await refresh();
              emitLoadout();
              return { loaded: matches.map((match) => match.name), tools: matches };
            },
          });
          activeToolNames = () => [
            ...equipped.filter((name) =>
              initial.has(name) || loaded.has(name) || isAlwaysActive(name)),
            FIND_TOOLS_TOOL_NAME,
            HIRE_SUBAGENT,
          ];
        } else {
          activeToolNames = () => [...equipped, HIRE_SUBAGENT];
        }
      } else {
        equipped = await equipClosedLoadout(turn, residentTools, deps.tools, hireSubagent);
        activeToolNames = () => equipped;
      }
      emitLoadout();

      // Spec 2026-08-05 §2, relocated: what the user's screen shows rides
      // BEHIND the history as this call's own context block, not inside the
      // system prompt — a snapshot that changes every message ahead of the
      // stable prompt is what kept the cache cold. Hires never see it: a
      // specialist gets a brief, not the user's screen.
      const trailing: readonly ModelMessage[] | undefined = turn.situation === undefined
        ? undefined
        : [{ role: "user", content: [{ type: "text", text: turn.situation }] }];

      // ONE attempt at the turn. The overflow retry re-enters through the same
      // function so the two attempts cannot drift on any input but the two the
      // retry means to change.
      const attempt = (
        attemptCompaction: TurnCompaction,
        /** What the failed attempt already produced, for a retry that CONTINUES
         *  the turn rather than restarting it. */
        resume?: readonly ModelMessage[],
      ): Promise<Awaited<ReturnType<typeof startTurn>>> =>
        // THE shipped loop. Every rail lives in it, so this harness cannot drift
        // from `createAgent` on any of them.
        startTurn({
          model,
          system,
          messages: [...turn.messages],
          tools: residentTools,
          signal: turn.signal,
          // §3.5 — the runtime already minted it and put it on the Turn, so
          // passing it is simply true.
          turnId: turn.turnId,
          workbenchAgent,
          // The loadout, in the loop's own vocabulary: `prepareStep` re-reads
          // this each step and restricts what the model may PICK, so a tool
          // searched in through `find_tools` is choosable on the next step and
          // one outside the loadout never is. Gates CHOICE only — execution is
          // always the guard-bound `turn.tools.call()`.
          activeTools: activeToolNames,
          // How big this seat's window is, and what the thread remembers about
          // filling it. Always passed: a deployment that never set a knob is
          // exactly the deployment that has never had a context rail at all.
          compaction: attemptCompaction,
          ...(resume === undefined ? {} : { resume }),
          ...(trailing === undefined ? {} : { trailing }),
          // The WHOLE context, not just `maxSteps`. Passing one knob is what made
          // every other knob unreachable from `vendo()` — the loop declared them,
          // `createAgent` passed them, and this caller silently dropped them, so
          // the two thinkers disagreed about a host's own configuration.
          ...(Object.keys(context).length === 0 ? {} : { context }),
        });

      let loop: Awaited<ReturnType<typeof startTurn>>;
      try {
        loop = await attempt(compaction);
      } catch (error) {
        yield { type: "error", message: wireErrorMessage(error), code: "model" };
        return;
      }

      /** The turn's single retry, spent. */
      let retried = false;
      for (;;) {
        /** Set when THIS attempt died on a prompt that did not fit. */
        let overflowed = false;
        try {
          for await (const part of loop.result.fullStream) {
            switch (part.type) {
              case "text-delta":
                yield { type: "text", delta: part.text };
                break;
              case "finish-step":
                // Which model actually served it, which a lazy seat cannot say
                // before the call and the provider says on every one. The step's
                // reported prompt COUNT is deliberately not read here: it is the
                // usage event's and the audit ledger's, and it drives no decision
                // (see `compaction.ts`'s header for the four bugs it caused when
                // it drove the trigger).
                rememberResolvedModelId(model, part.response.modelId);
                break;
              case "error":
                // A prompt that did not fit is the ONE provider failure this loop
                // can answer by itself: compact what the thread is carrying and
                // continue, silently, once. Everything else — and a second
                // overflow, and a caller who has already hung up — takes the
                // normal path below.
                if (!retried && !turn.signal.aborted && isContextOverflow(part.error)) {
                  overflowed = true;
                  break;
                }
                // `wireErrorMessage` is the SHIPPED formatter: a Vendo-shaped error
                // keeps its message and code, the Cloud meter's 402 becomes the
                // sentence with figures, reset date and both exits, and anything
                // else stays the fixed generic string. Provider internals never
                // travel; the operator's terminal gets the real error.
                yield { type: "error", message: wireErrorMessage(part.error), code: "model" };
                break;
              case "abort":
                // The caller hung up: stop cleanly, say nothing.
                return;
              case "finish":
                // The RESIDENT loop's own spend. Each hire's spend is yielded as
                // its own `usage` event after the drain (the receipt path and its
                // per-hire audit rows are gone), so the events partition the turn
                // and the runtime's `addUsage` sums them into the one run row.
                yield { type: "usage", ...usageOf(part.totalUsage, model) };
                break;
              default:
                // Tool call/result chunks are consumed here and dropped: the RUNTIME
                // mirrors them (§1.5), so echoing them would double every call.
                //
                // `tool-error` is dropped with them, and that is the rule: a turn
                // FAILS by how it ends — an `error` part, a throw out of this drain,
                // an abort — never by a step it recovered from. The SDK raises this
                // part for its own malformed-input/unknown-tool class, feeds it back,
                // and the model answers on the next step; a guarded call cannot raise
                // it at all, because `turn.tools.call()` never throws (§1.1) and its
                // failures are already a tool RESULT the model reads. Reporting it as
                // an `error` event made the runtime — right to treat a reported error
                // as the turn's death — stamp a finished turn failed: a permanent
                // "The response didn't finish" notice and a failed audit row above a
                // perfectly good answer.
                break;
            }
          }
        } catch (error) {
          yield { type: "error", message: wireErrorMessage(error), code: "model" };
          return;
        }
        if (!overflowed) break;
        retried = true;
        // Everything the failed attempt said and did, tool RESULTS included. It
        // rides the next prompt verbatim, below the compaction: each of those
        // calls has already run through `turn.tools.call()` and committed a real
        // effect, so an attempt that replayed them would transfer the money
        // twice. An overflow on the FIRST step produced no step at all, and `ai`
        // rejects `response` rather than resolving it empty — nothing to carry.
        const resume: readonly ModelMessage[] = await loop.result.response.then(
          (response) => response.messages,
          () => [],
        );
        try {
          loop = await attempt({ ...compaction, force: true }, resume);
        } catch (error) {
          yield { type: "error", message: wireErrorMessage(error), code: "model" };
          return;
        }
      }

      // Each helper's spend, through the one metering channel every brain has.
      // Yielded after the drain so the resident's own `finish` figure and the
      // hires' figures partition the turn; the runtime's `addUsage` sums them.
      for (const usage of hiredUsage) yield { type: "usage", ...usage };

      // §1.3's slot, which the runtime persists at turn end (`runtime.ts`
      // `onFinish` → `saveHarnessState`). Whatever the slot already carried
      // survives what this turn did not touch.
      //
      // What the slot holds is a SUMMARY and the boundary it absorbed, together or
      // not at all — half of that pair is not usable and the projection discards
      // it — plus the loadout memory (`loadedTools`), which rides the same
      // envelope. No measurement is carried. The provider's reported prompt count
      // used to live here, and it was the wrong kind of fact to persist: it
      // describes what a turn SENT while the next turn's trigger asks about what
      // the thread STORES, and after a compaction those are different sizes.
      // Every turn measures its own candidate prompt fresh instead
      // (`compaction.ts`).
      const compacted = loop.compacted ?? carried;
      const next: CompactionState | undefined =
        compacted !== undefined || loaded.size > 0
          ? {
              version: 1,
              ...compacted,
              ...(loaded.size > 0 ? { loadedTools: [...loaded] } : {}),
            }
          : undefined;
      if (next !== undefined) turn.state.set(writeCompactionState(next));
      // …and a state this turn REFUSED is destroyed rather than left in the row.
      // Declining to overwrite it is not the same thing: the boundary it names
      // could be re-created by a later edit, and the summary would come back to
      // life describing a branch nobody is on. (A refused SUMMARY dies here while
      // the loadout memory survives — the write above carries `loadedTools`
      // without the summary, which is exactly the split intended: a stale
      // boundary says nothing about which tools the thread loaded.)
      else if (stored !== undefined) turn.state.clear();

      const stepLimit = await loop.stepLimitPart();
      if (stepLimit !== undefined) {
        // Exhausting the cap is a SYSTEM fact: it rides the typed part core
        // defines, persisted as chrome — never spliced into the assistant's
        // voice (2026-08-10 ruling). The sentence is still the loop's, so both
        // callers say the same thing.
        yield { type: "notice", notice: stepLimit };
      }
    },
  });
  return harness;
}
