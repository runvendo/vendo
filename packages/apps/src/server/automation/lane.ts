/**
 * The automation door's lane: author one automation for an app, land the app's
 * own note of it, and arm it.
 *
 * This is a DOOR, not a rung. It used to hang off the escalation ladder as
 * `<Server kind="steps"|"agentic">` — the same ladder that reaches for a
 * machine — which meant "run this every morning" travelled the road built for
 * "this needs a server". Escalation now means the box and nothing else, and
 * authoring an automation is its own small entry point: no machine, no
 * sandbox, seconds rather than minutes.
 *
 * An automation is a RECORD of its own, owned by the principal who asked for it
 * and carrying no reference back to any app. What the app keeps is a list of
 * ids, maintained here and nowhere else, resolved on read with dead ids dropped.
 * So deleting the app does not stop the automation: it fires and fails loudly at
 * tool resolution, in the run ledger, which is the designed behavior.
 */
import {
  VendoError,
  type AppId,
  type ApprovalRequest,
  type AutomationId,
  type AutomationRecord,
  type AutomationTask,
  type RunContext,
} from "@vendoai/core";
import {
  type AppDocument,
  stripServerAuthoritativeFields,
} from "../../contract/index.js";
import type { Finding } from "../checking/types.js";
import type { GeneratedAppDocument, GenerationDependencies } from "../generation/engine.js";
import { rungFor, withoutId } from "../persistence/edit-journal.js";
import { generationDependencies } from "../runtime/generation-context.js";
import type { AppsRuntimeContext } from "../runtime/runtime-context.js";
import type { AppsRuntime, AutomationsSeam } from "../runtime/types.js";
import { planAutomation, type AutomationPlan } from "./plan.js";

/** The two ways an automation runs: fixed steps, or a judgment call per run. It
 *  IS `AutomationTask["kind"]` — one vocabulary from the door to the record. */
export type AutomationMode = AutomationTask["kind"];

const warn = (where: string, message: string): Finding => ({ severity: "warn", where, message });

const NO_ENGINE = "this deployment has no automations engine composed, so nothing can be scheduled — mount the automations block (createVendo's automations option) and ask again.";

/**
 * The ask says "one MORE", in the words people actually use for it.
 *
 * This is the mechanical half of create-vs-edit, and it exists because the
 * judgment half cannot be trusted with the destructive direction: the planner is
 * its own model call, and an existing entry in front of it is an invitation to
 * tidy up. In-thread, "add a second schedule alongside" came back as one
 * automation. When the person said "another one", no plan — however it points —
 * may land on an automation they already have.
 *
 * Deliberately one-way: it can only ever force an ADD. A false positive costs a
 * second entry the person can delete; the miss it prevents costs them an
 * automation they cannot get back.
 */
const ADDS_ANOTHER = /\b(also|another|second|third|too|as well|alongside|additionally|additional|in addition|on top of)\b/i;

/**
 * WHICH automation a plan lands on: the existing record it is a new version of,
 * or nothing at all — a new record beside them.
 *
 * The create operation replaces a record whose id it is given, so this is the
 * whole of create-vs-edit. {@link ADDS_ANOTHER} outranks the planner: an ask
 * that says "another one" can never overwrite something the person already has.
 */
export const replacedAutomationId = (
  plan: AutomationPlan,
  /** The person's own words, when the caller has them. */
  ask?: string,
): AutomationId | undefined =>
  ask !== undefined && ADDS_ANOTHER.test(ask) ? undefined : plan.replaces;

/** Put the automation onto the document: the app's note of the id, plus the
 *  results collection its last step publishes into.
 *
 *  The collection declaration is not bookkeeping: a screen may only query a
 *  collection the stored document declares (`app-data.ts` declaredStorage), so
 *  this is what lets the board rewire read the automation's rows at all. */
export const applyAutomationPlan = <Doc extends Pick<AppDocument, "automations" | "storage">>(
  document: Doc,
  plan: AutomationPlan,
  automationId: AutomationId,
): Doc => {
  const automated = structuredClone(document);
  const named = automated.automations ?? [];
  automated.automations = named.includes(automationId) ? named : [...named, automationId];
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
}): string => `The app now has a ${input.mode === "steps" ? "steps" : "goal-driven"} automation${input.name === undefined ? "" : ` ("${input.name}")`} that runs while the user is away and writes its latest displayable result into the app data collection "${input.resultsCollection}" — one record, id "latest", replaced on every run. Rewire the screen to show it:
- Read it with useQuery("vendo_apps_data_list", { appId: "${input.appId}", collection: "${input.resultsCollection}" }) — that input is LITERAL JSON, exactly as written. It answers { records: [{ id, data }] }, and a row's data is whatever the automation stored, so the latest result is records[0].data.
- The collection is EMPTY until the automation first fires, and this screen is rendered against the rows the query really returns before it can be saved — so handle records[0] being undefined and show one short "nothing yet" line instead of reading through it.
- Keep the layout; change only what is needed to surface the result (add one small section if none fits).`;

/**
 * Create the record and arm it. A seam that throws and a seam that answers
 * without arming are the SAME miss — an automation sitting silently disarmed is
 * one the person believes is running — so both come back as an honest sentence
 * naming the surface to use.
 */
export const armAutomation = async (
  seam: AutomationsSeam,
  id: AutomationId,
  ctx: RunContext,
): Promise<{ enabled: boolean; pendingGrants?: ApprovalRequest[]; issues: string[] }> => {
  try {
    const armed = await seam.enable(id, ctx);
    return {
      enabled: armed.enabled,
      ...(armed.missing.length === 0 ? {} : { pendingGrants: structuredClone(armed.missing) }),
      issues: armed.enabled
        ? []
        : [`the automation was created but the engine left it disabled — enable it explicitly (automations.enable / POST /automations/${id}/enable)`],
    };
  } catch (error) {
    return {
      enabled: false,
      issues: [`the automation was created but arming it failed (${error instanceof Error ? error.message : "unknown error"}) — enable it explicitly (automations.enable / POST /automations/${id}/enable)`],
    };
  }
};

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
   * {@link replacedAutomationId} reads the same words as the mechanical floor
   * under that decision.
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
  /** The ONE place the app's note of the automation reaches the stored row, and
   *  the first write of the two — the rewire's own save comes after it. */
  land: (document: GeneratedAppDocument) => Promise<void>;
  /** Unset ⇒ no engine is composed and nothing can be created; the app stands
   *  and the ask is refused in one sentence, never armed on paper. */
  automations?: AutomationsSeam;
}

export interface AutomationLaneResult {
  /** What the store holds when the lane is done: the landed document, or — once
   *  the rewire has saved over it — the row that save left behind. */
  document: GeneratedAppDocument;
  findings: Finding[];
  /** The automation that was created and armed. */
  automation?: {
    record: AutomationRecord;
    /** What the arming actually produced — false when the engine left it
     *  disarmed or arming threw (the issues entry says why). The thread's
     *  automation card needs the true state, not an inference. */
    enabled: boolean;
    resultsCollection?: string;
    /** Standing-grant approvals the enable flow surfaced. */
    pendingGrants?: ApprovalRequest[];
  };
  /** What arming had to say, for the CALLER — not just the operator's log. An
   *  automation the engine left disarmed (or failed to arm) is the person's
   *  problem to act on, and the sentence names the surface that fixes it, so it
   *  rides the edit result rather than only a findings line nobody reads. */
  armingIssues?: string[];
}

/**
 * Author one automation for this app, land the app's note of it, arm it, and
 * only THEN rewire the app around it.
 */
export const runAutomationLane = async (
  input: { appName: string; instruction: string; mode: AutomationMode },
  document: GeneratedAppDocument,
  deps: AutomationLaneDeps,
): Promise<AutomationLaneResult> => {
  const { mode } = input;
  const where = `server (${mode})`;
  const seam = deps.automations;
  if (seam === undefined) return { document, findings: [warn(where, NO_ENGINE)] };
  // What this app already runs. Without it the planner cannot say "this is a new
  // version of THAT one", and every re-plan of an existing automation would land
  // beside itself. Dead ids drop out here, which is the whole of the cleanup:
  // there is no cascade and no job that walks the lists.
  const existing = await seam.resolve(document.automations ?? [], deps.ctx);
  const planned = await planAutomation({
    appId: deps.appId,
    appName: input.appName,
    instruction: input.instruction,
    mode,
    tools: deps.tools ?? [],
    ...(deps.toolShapes === undefined ? {} : { toolShapes: deps.toolShapes }),
    ...(existing.length === 0 ? {} : { existing }),
  }, deps.model);
  if (planned.kind === "failure") {
    return {
      document,
      findings: [
        warn(where, `this app needs ${mode === "steps" ? "a scheduled/triggered steps" : "a goal-driven"} automation, but no valid plan validated — the rest of the app stands without it.`),
        ...planned.issues.map((issue) => warn(where, issue)),
      ],
    };
  }
  const { plan } = planned;
  const findings: Finding[] = [];
  // THE one create operation — the same one `agent.on`, `vendo_automate` and the
  // manifest fold-in call. An id it already holds is REPLACED, which is what
  // makes "move the digest to 9am" a change rather than a second digest.
  const replaces = replacedAutomationId(plan, deps.request);
  const record = await seam.create({
    ...(replaces === undefined ? {} : { id: replaces }),
    owner: deps.ctx.principal,
    when: plan.when,
    task: plan.task,
    authoredBy: "chat",
  }, deps.ctx);
  let landed = applyAutomationPlan(document, plan, record.id);
  await deps.land(landed);
  const armed = await armAutomation(seam, record.id, deps.ctx);
  findings.push(...armed.issues.map((issue) => warn(where, issue)));
  // The rewire comes AFTER the land, and has to: the assembler reads the STORED
  // row, and a screen may only query a collection that row DECLARES
  // (`app-data.ts` declaredStorage) — the checks run the rewired screen's query
  // for real, so a rewire asked any earlier is refused with "records collection
  // not found". Its own save carries this row's automations list and storage
  // forward, so the row it leaves behind IS the answer. A failed rewire never
  // blocks the automation: it is created and armed either way, and the miss is
  // reported for a retry.
  if (plan.resultsCollection !== undefined && deps.rebind !== undefined) {
    const rebound = await deps.rebind(automationResultsInstruction({
      appId: deps.appId,
      mode,
      ...(plan.name === undefined ? {} : { name: plan.name }),
      resultsCollection: plan.resultsCollection,
    }));
    if (rebound.document === undefined) {
      findings.push(warn(where, "the automation is armed, but the app was not rewired to show its results — ask for the board again and it will bind to the results collection."));
      findings.push(...rebound.issues.map((issue) => warn(where, issue)));
    } else {
      landed = rebound.document;
    }
  }
  return {
    document: landed,
    findings,
    ...(armed.issues.length === 0 ? {} : { armingIssues: armed.issues }),
    automation: {
      record,
      enabled: armed.enabled,
      ...(plan.resultsCollection === undefined ? {} : { resultsCollection: plan.resultsCollection }),
      ...(armed.pendingGrants === undefined ? {} : { pendingGrants: armed.pendingGrants }),
    },
  };
};

/**
 * The automation door: author one automation for a STORED app.
 *
 * The ONE wiring — the public `automation.author` door and `vendo_make`'s
 * compound ask both come through here, so they can never create, arm or audit
 * differently. It lands the app's note through the ordinary edit persist, and
 * records the `automation-created` audit row: something that fires unattended is
 * exactly the kind of event an audit trail exists for.
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
      /** The person's own words, for the create-vs-replace decision and the version row. */
      request: string;
      document: AppDocument;
    },
    ctx: RunContext,
    generation: GenerationDependencies,
    automations?: AutomationsSeam,
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
        ...(automations === undefined ? {} : { automations }),
        land: async (document) => {
          const previous = await requireOwned(appId, ctx);
          const next: AppDocument = { ...document, id: appId };
          if (next.tree !== undefined) stripServerAuthoritativeFields(next.tree);
          await persistEdit(
            previous,
            next,
            { at: new Date().toISOString(), intent: input.request, rung: rungFor(next) },
            ctx.principal.subject,
            { origin: "automation" },
          );
        },
        // The board that shows an automation's results is a SCREEN, so the thing
        // that writes every other screen writes this one: one assembler turn over
        // the app as it stands — which, by the time this runs, is the row the
        // automation's id already landed in. The assembler's own save carries that
        // row's list and storage forward, so the app can never lose its note of
        // the automation to its own rewire, and the row it leaves behind is what
        // comes back here.
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
        automationId: lane.automation.record.id,
        taskKind: lane.automation.record.task.kind,
        triggerKind: lane.automation.record.when.kind,
      });
    }
    return lane;
  };
  return authorAutomation;
};

/**
 * `AppsRuntime.automation` — the public door.
 *
 * The same wiring `vendo_make`'s compound ask uses, so an automation authored by
 * asking for one directly and one that came along with an app create, arm and
 * audit identically.
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
        config.automations,
      );
      if (lane.automation === undefined) {
        return { ok: false, issues: lane.findings.map(({ message }) => message) };
      }
      return {
        ok: true,
        document: { ...lane.document, id: input.appId },
        record: lane.automation.record,
        armed: lane.automation.enabled,
      };
    },
  };
};
