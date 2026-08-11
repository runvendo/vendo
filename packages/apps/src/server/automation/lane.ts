/**
 * The automation door's lane: author one automation onto an app, land it, and
 * arm it.
 *
 * This is a DOOR, not a rung. It used to hang off the escalation ladder as
 * `<Server kind="steps"|"agentic">` — the same ladder that reaches for a
 * machine — which meant "run this every morning" travelled the road built for
 * "this needs a server". Escalation now means the box and nothing else, and
 * authoring an automation is its own small entry point: no machine, no
 * sandbox, seconds rather than minutes.
 *
 * Nothing here was rewritten in the move. The planner (`plan.ts`), the id rules
 * and the arming are the same code that ran inside `generation/lanes.ts`; only
 * their home changed.
 */
import {
  DEFAULT_TRIGGER_ID,
  TRIGGER_ID_PATTERN,
  VendoError,
  type AppId,
  type ApprovalRequest,
  type RunContext,
  type Trigger,
} from "@vendoai/core";
import {
  type AppDocument,
  type PlanServer,
  stripServerAuthoritativeFields,
} from "../../contract/index.js";
import type { Finding } from "../checking/types.js";
import type { GeneratedAppDocument, GenerationDependencies } from "../generation/engine.js";
import { rungFor, withoutId } from "../persistence/edit-journal.js";
import { generationDependencies } from "../runtime/generation-context.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime } from "../runtime/types.js";
import { planAutomation, type AutomationPlan } from "./plan.js";

/** The two ways an automation runs: fixed steps, or a judgment call per run. */
export type AutomationMode = "steps" | "agentic";

/** The mode an escalated plan's `<Server>` asks this door for, or `undefined`
 *  when it asked for the box instead. The one place a `<Server kind>` is read
 *  as an automation — the ladder itself no longer knows these two exist. */
export const automationMode = (server: PlanServer): AutomationMode | undefined =>
  server.kind === "box" ? undefined : server.kind;

const warn = (where: string, message: string): Finding => ({ severity: "warn", where, message });

/** The host's arming seam (`AppsConfig.armAutomation`). */
export type ArmAutomationSeam = (
  appId: AppId,
  triggerId: string,
  ctx: RunContext,
) => Promise<{ enabled: boolean; missing: ApprovalRequest[] }>;

/** The id-less plan trigger as the document carries it, under the id the app's
 *  own list gives it ({@link plannedTriggerId}). */
const stampedTrigger = (plan: AutomationPlan, id: string): Trigger =>
  ({ id, ...structuredClone(plan.trigger) });

/** The id a nameless plan lands under. A plan the model gave no name has no
 *  identity of its own, so it takes the one id reserved for that — and the next
 *  nameless plan is read as the same automation said again. */
const UNNAMED_TRIGGER_ID = "automation";

/** An automation's name as a trigger id: the bare-identifier grammar of
 *  `TRIGGER_ID_PATTERN`, which a trigger id obeys because it is read back in
 *  URLs, wire payloads and store refs. Undefined when the name holds nothing an
 *  identifier can be made of. */
const idFromName = (name: string | undefined): string | undefined => {
  const bare = (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (bare === "") return undefined;
  return TRIGGER_ID_PATTERN.test(bare) ? bare : `_${bare}`;
};

/**
 * The ask says "one MORE", in the words people actually use for it.
 *
 * This is the mechanical half of create-vs-edit, and it exists because the
 * judgment half cannot be trusted with the destructive direction: the planner is
 * its own model call, and an existing entry in front of it is an invitation to
 * tidy up. In-thread, "add a second schedule alongside" came back as one
 * trigger. When the person said "another one", no plan — however it points — may
 * land on an automation they already have.
 *
 * Deliberately one-way: it can only ever force an ADD. A false positive costs a
 * second entry the person can delete; the miss it prevents costs them an
 * automation they cannot get back.
 */
const ADDS_ANOTHER = /\b(also|another|second|third|too|as well|alongside|additionally|additional|in addition|on top of)\b/i;

/** The first id in the `base`, `base_2`, `base_3` … series the app does not
 *  already hold. Safe to search occupancy because the id is decided ONCE per
 *  authoring, before anything is stamped. */
const freeTriggerId = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
};

/**
 * Which entry of the app's list a planned automation lands on.
 *
 * An app carries a LIST of triggers, so "add an alert to my dashboard" adds an
 * ENTRY: the first automation an app gets is {@link DEFAULT_TRIGGER_ID} — the id
 * everything pre-list normalizes to, and the one adoption, sponsorship and grant
 * defaults key on — and every automation after it is named after ITSELF. That is
 * what makes "also remind me weekly" a second automation instead of a rewrite of
 * the first.
 *
 * A trigger id IS the automation's name inside its app (core `triggers.ts`), so a
 * plan whose name derives to an id the app already holds is that same automation
 * said again — an edit — and it replaces its own entry, never a sibling's. The
 * app's FIRST automation has no name in its id, so an edit of that one says which
 * entry it means outright: `plan.replaces`, which the planner sets from the app's
 * own list.
 *
 * And an ask that says "another one" outranks both: {@link ADDS_ANOTHER} makes
 * APPEND the default direction, so neither a lazy `replaces` nor a name reused
 * from the existing entry can land on an automation the person already has.
 *
 * Called ONCE per authoring, before anything is stamped — which is what makes
 * the occupancy search safe, and what keeps the entry the plan lands on, the
 * arming, and the trigger the caller's card renders all one automation.
 */
export const plannedTriggerId = (
  triggers: readonly Pick<Trigger, "id">[] | undefined,
  plan: AutomationPlan,
  /** The person's own words, when the caller has them. */
  ask?: string,
): string => {
  const existing = triggers ?? [];
  if (existing.length === 0) return DEFAULT_TRIGGER_ID;
  const taken = new Set(existing.map(({ id }) => id));
  const named = idFromName(plan.name) ?? UNNAMED_TRIGGER_ID;
  if (ask !== undefined && ADDS_ANOTHER.test(ask)) return freeTriggerId(named, taken);
  if (plan.replaces !== undefined && taken.has(plan.replaces)) return plan.replaces;
  return named;
};

/** Put a planned automation onto a document: the trigger the automations engine
 *  fires, plus the results collection its last step publishes into. The entry is
 *  replaced IN PLACE when the app already holds that id (an edit of that same
 *  automation), and appended when it does not — so every other automation the app
 *  has keeps its own place in the list.
 *
 *  The collection declaration is not bookkeeping: a screen may only query a
 *  collection the stored document declares (`app-data.ts` declaredStorage), so
 *  this is what lets the board rewire read the automation's rows at all. */
export const applyAutomationPlan = <Doc extends Pick<AppDocument, "triggers" | "storage">>(
  document: Doc,
  plan: AutomationPlan,
  triggerId: string,
): Doc => {
  const automated = structuredClone(document);
  const stamped = stampedTrigger(plan, triggerId);
  const existing = automated.triggers ?? [];
  automated.triggers = existing.some((trigger) => trigger.id === triggerId)
    ? existing.map((trigger) => (trigger.id === triggerId ? stamped : trigger))
    : [...existing, stamped];
  if (plan.resultsCollection !== undefined && automated.storage?.[plan.resultsCollection] === undefined) {
    automated.storage = {
      ...automated.storage,
      [plan.resultsCollection]: {
        about: `Latest results written by the "${plan.name ?? "automation"}" automation for the app board.`,
        kind: "records",
      },
    };
  }
  return automated;
};

/** The rewire that makes an away run VISIBLE: the app's screen reads the store
 *  rows the automation publishes, so without this the automation fires into
 *  nothing the person can see.
 *
 *  Read by the ONE screen builder, so it speaks the component dialect and only
 *  its own delta from it — the builder's brief already teaches the file. */
export const automationResultsInstruction = (input: {
  appId: string;
  mode: AutomationMode;
  /** The automation's own name, when it has one. */
  name?: string;
  resultsCollection: string;
}): string => `The app now has a ${input.mode} automation${input.name === undefined ? "" : ` ("${input.name}")`} that runs while the user is away and writes its latest displayable result into the app data collection "${input.resultsCollection}" — one record, id "latest", replaced on every run. Rewire the screen to show it:
- Read it with useQuery("vendo_apps_data_list", { appId: "${input.appId}", collection: "${input.resultsCollection}" }) — that input is LITERAL JSON, exactly as written. It answers { records: [{ id, data }] }, and a row's data is whatever the automation stored, so the latest result is records[0].data.
- The collection is EMPTY until the automation first fires, and this screen is rendered against the rows the query really returns before it can be saved — so handle records[0] being undefined and show one short "nothing yet" line instead of reading through it.
- Keep the layout; change only what is needed to surface the result (add one small section if none fits).`;

/**
 * Arm a freshly authored trigger through the host's seam. A seam that throws
 * and a seam that answers without arming are the SAME miss — a trigger sitting
 * silently disarmed is an automation the person believes is running — so both
 * come back as an honest sentence naming the surface to use. No seam means the
 * stored row was armed by the persist itself, and there is nothing to do.
 */
export const armAutomationTrigger = async (
  seam: ArmAutomationSeam | undefined,
  appId: AppId,
  triggerId: string,
  ctx: RunContext,
): Promise<{ enabled: boolean; pendingGrants?: ApprovalRequest[]; issues: string[] }> => {
  if (seam === undefined) return { enabled: true, issues: [] };
  try {
    const armed = await seam(appId, triggerId, ctx);
    return {
      enabled: armed.enabled,
      ...(armed.missing.length === 0 ? {} : { pendingGrants: structuredClone(armed.missing) }),
      issues: armed.enabled
        ? []
        : ["the automation was authored but the arming seam left it disabled — enable it explicitly via the automations engine (automations.enable / POST /automations/:appId/enable)"],
    };
  } catch (error) {
    return {
      enabled: false,
      issues: [`the automation was authored but arming it failed (${error instanceof Error ? error.message : "unknown error"}) — enable it explicitly via the automations engine (automations.enable / POST /automations/:appId/enable)`],
    };
  }
};

/** What the planner is answering when the ask arrived through an escalated
 *  plan: the person's own words first when the caller has them — "another one"
 *  and "move it to 9am" are the same shape of sentence to everything
 *  downstream, and only the request tells them apart — then the plan's `why`,
 *  the brain's sentence about what has to happen away from the browser. */
export const automationInstruction = (server: PlanServer, request: string | undefined): string => [
  ...(request === undefined || request.trim() === ""
    ? []
    : [`WHAT THEY ASKED FOR, IN THEIR OWN WORDS: ${request}`]),
  server.why,
  ...(server.schedule === undefined ? [] : [`WHEN: ${server.schedule}`]),
].join("\n");

export interface AutomationLaneDeps extends GenerationDependencies {
  /** The stored app's id: the automation's publish step and the results query
   *  both name it literally. */
  appId: AppId;
  ctx: RunContext;
  /**
   * The person's own words for this change.
   *
   * The instruction the planner reads may be composed (an escalated plan's
   * `why` above their ask); the planner decides whether this is one more
   * automation or a new version of one they already have, and
   * {@link plannedTriggerId} reads the same words as the mechanical floor under
   * that decision.
   */
  request?: string;
  /**
   * Rewire the app to surface something new (the automation's results rows).
   * Wired to one turn of the screen assembler — the one builder — so the board
   * that appears is written by the same thing that writes every other screen.
   * Absent → the automation still arms and the missing board is a `warn`,
   * exactly as a failed rewire is.
   *
   * It takes the instruction and nothing else: the assembler opens the app's own
   * STORED row, so the document to rewire is never handed to it — which is why
   * this runs after `land`.
   */
  rebind?: (instruction: string) => Promise<{ document?: GeneratedAppDocument; issues: string[] }>;
  /**
   * The ONE place the TRIGGER reaches the stored row, and the first write of the
   * two — the rewire's own save comes after it. `armTrigger` is the persist's own
   * arming — true exactly when the host wired no arming seam. Absent → the lane
   * authors the automation and hands it back unlanded, arms nothing, and rewires
   * nothing (arming a row whose trigger is not stored yet would enable an
   * automation that does not exist).
   */
  land?: (document: GeneratedAppDocument, options: { armTrigger: boolean }) => Promise<void>;
  armAutomation?: ArmAutomationSeam;
}

export interface AutomationLaneResult {
  /** What the store holds when the lane is done: the landed document, or — once
   *  the rewire has saved over it — the row that save left behind. */
  document: GeneratedAppDocument;
  findings: Finding[];
  /** The automation that was authored and armed. */
  automation?: {
    mode: AutomationMode;
    trigger: Trigger;
    /** What the arming actually produced — false when the seam left the trigger
     *  disarmed or arming threw (the issues entry says why). The thread's
     *  automation card needs the true state, not an inference. */
    enabled: boolean;
    resultsCollection?: string;
    /** Standing-grant approvals the arming seam surfaced. */
    pendingGrants?: ApprovalRequest[];
  };
  /** What arming had to say, for the CALLER — not just the operator's log. A
   *  trigger the seam left disarmed (or failed to arm) is the person's problem
   *  to act on, and the sentence names the surface that fixes it, so it rides
   *  the edit result rather than only a findings line nobody downstream reads. */
  armingIssues?: string[];
}

/**
 * Author one automation onto the document, land it, arm it, and only THEN rewire
 * the app around it.
 */
export const runAutomationLane = async (
  input: { appName: string; instruction: string; mode: AutomationMode },
  document: GeneratedAppDocument,
  deps: AutomationLaneDeps,
): Promise<AutomationLaneResult> => {
  const { mode } = input;
  const where = `server (${mode})`;
  const planned = await planAutomation({
    appId: deps.appId,
    appName: input.appName,
    instruction: input.instruction,
    mode,
    tools: deps.tools ?? [],
    ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
    // What this app already runs. Without it the planner cannot say "this is a
    // new version of THAT one", and every re-plan of an existing automation
    // would land beside itself.
    ...(document.triggers === undefined || document.triggers.length === 0
      ? {}
      : { existing: document.triggers }),
  }, deps.model);
  if (planned.kind === "failure") {
    return {
      document,
      findings: [
        warn(where, `this app needs ${mode === "steps" ? "a scheduled/triggered steps" : "an agentic"} automation, but no valid plan validated — the rest of the app stands without it.`),
        ...planned.issues.map((issue) => warn(where, issue)),
      ],
    };
  }
  const { plan: automation } = planned;
  const findings: Finding[] = [];
  // Decided ONCE, off the app as it stands: everything below — the entry the plan
  // lands on, the arming, the trigger the caller's card renders — has to mean the
  // same automation.
  const triggerId = plannedTriggerId(document.triggers, automation, deps.request);
  let landed = applyAutomationPlan(document, automation, triggerId);
  let pendingGrants: ApprovalRequest[] | undefined;
  // Arming — and the board rewire under it — only ever happens on the land path:
  // either inside land() itself (armTrigger) or through the host's seam right
  // after it. With no `land`, the automation was authored and handed back
  // UNSTORED, so nothing armed it and it is not enabled: claiming otherwise would
  // put a live-looking card in the thread for a trigger that does not exist in
  // any row.
  let enabled = false;
  let armingIssues: string[] = [];
  if (deps.land !== undefined) {
    await deps.land(landed, { armTrigger: deps.armAutomation === undefined });
    const armed = await armAutomationTrigger(deps.armAutomation, deps.appId, triggerId, deps.ctx);
    pendingGrants = armed.pendingGrants;
    enabled = armed.enabled;
    armingIssues = armed.issues;
    findings.push(...armed.issues.map((issue) => warn(where, issue)));
    // The rewire comes AFTER the land, and has to: the assembler reads the STORED
    // row, and a screen may only query a collection that row DECLARES
    // (`app-data.ts` declaredStorage) — the checks run the rewired screen's query
    // for real, so a rewire asked any earlier is refused with "records collection
    // not found". Its own save carries this row's trigger and storage forward, so
    // the row it leaves behind IS the answer and there is nothing to re-stamp. A
    // failed rewire never blocks the automation: it is landed and armed either
    // way, and the miss is reported for a retry.
    if (automation.resultsCollection !== undefined && deps.rebind !== undefined) {
      const rebound = await deps.rebind(automationResultsInstruction({
        appId: deps.appId,
        mode,
        ...(automation.name === undefined ? {} : { name: automation.name }),
        resultsCollection: automation.resultsCollection,
      }));
      if (rebound.document === undefined) {
        findings.push(warn(where, "the automation is armed, but the app was not rewired to show its results — ask for the board again and it will bind to the results collection."));
        findings.push(...rebound.issues.map((issue) => warn(where, issue)));
      } else {
        landed = rebound.document;
      }
    }
  }
  return {
    document: landed,
    findings,
    ...(armingIssues.length === 0 ? {} : { armingIssues }),
    automation: {
      mode,
      trigger: stampedTrigger(automation, triggerId),
      enabled,
      ...(automation.resultsCollection === undefined ? {} : { resultsCollection: automation.resultsCollection }),
      ...(pendingGrants === undefined ? {} : { pendingGrants }),
    },
  };
};

/**
 * The automation door: author one automation onto a STORED app.
 *
 * The ONE wiring — the public `automation.author` door and the escalated
 * plan that asks for an automation both come through here, so they can never
 * land, arm or audit differently. It lands through the ordinary edit persist
 * (arming a trigger whose row does not exist yet would enable an automation
 * nobody has), and records the `automation-created` audit row: a trigger that
 * fires unattended is exactly the kind of event an audit trail exists for.
 */
export const createAutomationLane = (
  deps: Pick<AppsRuntimeContext,
    "requireOwned" | "persistEdit" | "assembleEdit" | "reportGuard">,
) => {
  const { requireOwned, persistEdit, assembleEdit, reportGuard } = deps;
  const authorAutomation = async (
    input: {
      appId: AppId;
      /** What the planner reads — the ask, or an escalated plan's composed brief. */
      instruction: string;
      mode: AutomationMode;
      /** The person's own words, for the trigger-id decision and the version row. */
      request: string;
      document: AppDocument;
    },
    ctx: RunContext,
    generation: GenerationDependencies,
    armAutomation?: ArmAutomationSeam,
  ): Promise<AutomationLaneResult> => {
    const { appId } = input;
    const lane = await runAutomationLane(
      { appName: input.document.name, instruction: input.instruction, mode: input.mode },
      withoutId(input.document),
      {
        ...generation,
        appId,
        ctx,
        request: input.request,
        ...(armAutomation === undefined ? {} : { armAutomation }),
        land: async (document, options) => {
          const previous = await requireOwned(appId, ctx);
          const next: AppDocument = { ...document, id: appId };
          if (next.tree !== undefined) stripServerAuthoritativeFields(next.tree);
          await persistEdit(
            previous,
            next,
            { at: new Date().toISOString(), intent: input.request, rung: rungFor(next) },
            ctx.principal.subject,
            { ...options, origin: "automation" },
          );
        },
        // The board that shows an automation's results is a SCREEN, so the thing
        // that writes every other screen writes this one: one assembler turn over
        // the app as it stands — which, by the time this runs, is the row the
        // automation already landed in. The assembler's own save carries that
        // row's trigger and storage forward, so the automation can never be lost
        // to its own rewire, and the row it leaves behind is what comes back here.
        rebind: async (instruction) => {
          const rebound = await assembleEdit(appId, instruction, ctx);
          if (rebound.kind === "assembled") return { document: withoutId(rebound.app), issues: [] };
          return {
            issues: rebound.kind === "escalate"
              ? ["the assembler asked for a build rather than rewiring the board"]
              : rebound.issues,
          };
        },
      },
    );
    if (lane.automation !== undefined) {
      await reportGuard(ctx.principal.subject, appId, ctx, {
        operation: "automation-created",
        mode: lane.automation.mode,
        triggerKind: lane.automation.trigger.on.kind,
      });
    }
    return lane;
  };
  return authorAutomation;
};

/**
 * `AppsRuntime.automation` — the public door.
 *
 * The same wiring the escalated-plan path uses, so an automation authored by
 * asking for one directly and an automation authored through a plan land, arm
 * and audit identically.
 */
export const createAutomationDoor = (
  deps: Pick<AppsRuntimeContext,
    "config" | "requireOwned" | "generationToolContext" | "authorAutomation">,
): AppsRuntime["automation"] => {
  const { config, requireOwned, generationToolContext, authorAutomation } = deps;
  return {
    async author(input, ctx) {
      if (config.model === undefined) {
        throw new VendoError("not-implemented", "authoring an automation requires a model");
      }
      const document = await requireOwned(input.appId, ctx);
      const lane = await authorAutomation(
        { ...input, request: input.instruction, document },
        ctx,
        generationDependencies(config, config.model, await generationToolContext(ctx)),
        config.armAutomation,
      );
      if (lane.automation === undefined) {
        return { ok: false, issues: lane.findings.map(({ message }) => message) };
      }
      return {
        ok: true,
        document: { ...lane.document, id: input.appId },
        triggerId: lane.automation.trigger.id,
        armed: lane.automation.enabled,
      };
    },
  };
};
