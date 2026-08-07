/**
 * The server lane: the one thing a plan can declare that assembly cannot write —
 * work that does not happen in the browser.
 *
 * It is an EARNED escape. The escalating agent decided in its plan that the work
 * cannot happen in the browser; this runner just executes what the plan declared.
 * Nothing here re-judges the escape, and nothing here rebuilds the machinery it
 * drives: automations ride `planAutomation` and the automations engine's own
 * arming, and the box is the existing machine lifecycle plus the in-box agent.
 *
 * The box lane is where the bind-after-build law lives: NOTHING pre-declares
 * the functions a box will serve. The lane hands the box the plan it is building
 * and the person's own words, the box writes whatever code the job needs, and
 * only then does it report the interface it actually serves — with real sampled
 * output. A pre-declared signature would be the app promising something no one
 * has written yet.
 *
 * Every failure here is SECTION-sized, never app-sized: a failed box comes back
 * as `warn` findings with the document unchanged, and the rest of the app stands.
 */
import {
  DEFAULT_TRIGGER_ID,
  TRIGGER_ID_PATTERN,
  type AppDocument,
  type AppId,
  type AppPlan,
  type ApprovalRequest,
  type Json,
  type PlanServer,
  type RunContext,
  type Trigger,
} from "@vendoai/core";
import { planAutomation, type AutomationPlan } from "../automation-plan.js";
import { prepareIslands } from "../checking/islands.js";
import { smokeRenderIslands } from "../checking/smoke-render.js";
import type { Finding } from "../checking/types.js";
import type { GeneratedAppDocument, GenerationDependencies } from "./engine.js";

/** What a lane leaves behind. `document` is byte-identical to the input when
 *  the lane failed honestly — a lane never ships half of itself. */
export interface LaneResult {
  document: GeneratedAppDocument;
  findings: Finding[];
}

const warn = (where: string, message: string): Finding => ({ severity: "warn", where, message });

// ---------------------------------------------------------------------------
// The automation arm's reusable internals (shared with runtime.ts automate())
// ---------------------------------------------------------------------------

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
 * the occupancy search safe and keeps the two stamps of one plan (before the
 * board rewire, and over the rewired document) on the same entry.
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
 *  replaced IN PLACE when the app already holds that id (the rewire re-stamp, and
 *  an edit of that same automation), and appended when it does not — so every
 *  other automation the app has keeps its own place in the list. */
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

/** The rewire that makes an away run VISIBLE: the app's board reads the store
 *  rows the automation publishes, so without this the automation fires into
 *  nothing the person can see. */
export const automationResultsInstruction = (input: {
  appId: string;
  mode: "steps" | "agentic";
  /** The automation's own name, when it has one. */
  name?: string;
  resultsCollection: string;
}): string => `The app now has a ${input.mode} automation${input.name === undefined ? "" : ` ("${input.name}")`} that runs while the user is away and writes its latest displayable result into the app data collection "${input.resultsCollection}" (record id "latest"). Rewire the tree to show those results:
- Add (or repoint) a query over the results rows: <Query id="results" tool="vendo_apps_data_list" input={{appId:"${input.appId}", collection:"${input.resultsCollection}"}}/> — the input is LITERAL JSON exactly as written. The tool's result shape is {records: [{id, data: <what the automation stored>}]}, so bind node props against /results/records/... paths (e.g. {results.records.0.data.summary}).
- Keep the layout; change only what is needed to surface the automation's results (add a small section if none fits).
- Emit no id attributes on nodes (ids are compiler-owned); a <Query> id is its name.`;

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

// ---------------------------------------------------------------------------
// The server lane
// ---------------------------------------------------------------------------

/**
 * One function a box reports AFTER building it. The sample is the only real
 * shape in existence for it: nothing declared these functions up front, so the
 * app's waiting groups bind against what actually ran.
 */
export interface ServerFunction {
  name: string;
  /** A real sample of the function's output. Absent when no sample could be
   *  taken — a group binding then has the name and nothing else. */
  sampleOutput?: Json;
}

/** What the box says after the work (pure data — a box result never carries
 *  host authority; see box-agent.ts). */
export interface BoxOutcome {
  ok: boolean;
  /** The box's own words about what it did; user- and model-facing on failure. */
  summary: string;
  functions?: readonly ServerFunction[];
  /** The box's own claim that it serves the app's whole surface. DATA, never a
   *  decision: it is one of the two signals a layer-3 flip needs. */
  servesUi?: boolean;
  /** The HOST's verification of that claim — it fetched `GET /` itself and got a
   *  real HTML page. The claim alone never flips a surface. */
  servedOk?: boolean;
}

/**
 * The box, as the lane needs it, in the order it needs it. Task 10 wires this
 * to the runtime's machine lifecycle and `editServerViaBox`: `instruct` wakes
 * the machine, hands the in-box agent the prompt, and — on failure — discards
 * the live machine WITHOUT snapshotting, so a failed box leaves nothing to
 * inherit. `functions` comes from the box's reported fn list, each sampled by
 * calling it (the fn caller the graduation path already uses).
 */
export interface BoxSeam {
  /** False when no sandbox adapter is configured or machines are disabled. The
   *  lane checks this BEFORE provisioning anything. */
  available(): boolean;
  /** Provision a machine for an app that has none. Idempotent. */
  provision(): Promise<void>;
  instruct(instruction: string): Promise<BoxOutcome>;
}

export interface ServerLaneDeps extends GenerationDependencies {
  /** The stored app's id: the automation's publish step and the results query
   *  both name it literally. */
  appId: AppId;
  ctx: RunContext;
  /**
   * The person's own words for this change.
   *
   * The plan's `why` is the BRAIN's sentence about the away work, and it says
   * nothing about whether this is one more automation or a new version of one
   * they already have. The planner decides that, so it gets the request itself —
   * and {@link plannedTriggerId} reads the same words as the mechanical floor
   * under that decision.
   */
  request?: string;
  /**
   * The escalated `plan.vendo` as the escalating agent WROTE it.
   *
   * The box's brief is the plan itself, not a summary of it: the person is
   * already looking at this plan's skeleton, and the compiled `AppPlan` has
   * dropped everything the compiler had no field for — the prose in a group's
   * title, the ordering, the `<Cannot>` lines. Absent → the brief falls back to
   * the compiled plan's own fields, which is all a caller with no plan file has.
   */
  planText?: string;
  /**
   * Rewire the app to surface something new (the automation's results rows).
   * Wired to one turn of the screen assembler — the one builder — so the board
   * that appears is written by the same thing that writes every other screen.
   * Absent → the automation still arms and the missing board is a `warn`,
   * exactly as a failed rewire is.
   */
  rebind?: (
    instruction: string,
    document: GeneratedAppDocument,
  ) => Promise<{ document?: GeneratedAppDocument; issues: string[] }>;
  /**
   * The ONE place the automation reaches the stored row. `armTrigger` is the
   * persist's own arming — true exactly when the host wired no arming seam.
   * Absent → the lane authors the automation and hands it back unlanded, and
   * arms nothing (arming a row whose trigger is not stored yet would enable an
   * automation that does not exist).
   */
  land?: (document: GeneratedAppDocument, options: { armTrigger: boolean }) => Promise<void>;
  armAutomation?: ArmAutomationSeam;
  box?: BoxSeam;
}

export interface ServerLaneResult extends LaneResult {
  /** steps/agentic: the automation that was authored and armed. */
  automation?: {
    mode: "steps" | "agentic";
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
  /** box: the interface the box reported after building. The plan's
   *  `waitsForServer` groups fill against these samples. `servesUi`/`servedOk`
   *  ride along for the layer-3 flip the runtime owns (it is the only place that
   *  can rewrite the stored surface). */
  server?: {
    summary: string;
    functions: ServerFunction[];
    servesUi?: boolean;
    servedOk?: boolean;
  };
}

/** What the planner is answering: the person's own words first when the caller
 *  has them — "another one" and "move it to 9am" are the same shape of sentence
 *  to everything downstream, and only the request tells them apart — then the
 *  plan's `why`, the brain's sentence about what has to happen away from the
 *  browser. */
const automationInstruction = (server: PlanServer, request: string | undefined): string => [
  ...(request === undefined || request.trim() === ""
    ? []
    : [`WHAT THEY ASKED FOR, IN THEIR OWN WORDS: ${request}`]),
  server.why,
  ...(server.schedule === undefined ? [] : [`WHEN: ${server.schedule}`]),
].join("\n");

const runAutomationArm = async (
  plan: AppPlan,
  document: GeneratedAppDocument,
  deps: ServerLaneDeps,
  mode: "steps" | "agentic",
): Promise<ServerLaneResult> => {
  const server = plan.server as PlanServer;
  const where = `server (${mode})`;
  const planned = await planAutomation({
    appId: deps.appId,
    appName: plan.name,
    instruction: automationInstruction(server, deps.request),
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
  // Decided ONCE, off the app as it stands: everything below — the re-stamp over
  // the rewired document, the arming, the trigger the caller's card renders —
  // has to mean the same entry.
  const triggerId = plannedTriggerId(document.triggers, automation, deps.request);
  let landed = applyAutomationPlan(document, automation, triggerId);
  // Bind the board to the results rows BEFORE landing, so one write carries the
  // whole change. A failed rewire never blocks the automation: the trigger
  // still lands and the miss is reported for a retry.
  if (automation.resultsCollection !== undefined && deps.rebind !== undefined) {
    const rebound = await deps.rebind(automationResultsInstruction({
      appId: deps.appId,
      mode,
      ...(automation.name === undefined ? {} : { name: automation.name }),
      resultsCollection: automation.resultsCollection,
    }), landed);
    if (rebound.document === undefined) {
      findings.push(warn(where, "the automation is armed, but the app was not rewired to show its results — ask for the board again and it will bind to the results collection."));
      findings.push(...rebound.issues.map((issue) => warn(where, issue)));
    } else {
      // Re-stamp: the rewire must never drop the just-authored automation.
      landed = applyAutomationPlan(rebound.document, automation, triggerId);
    }
  }
  let pendingGrants: ApprovalRequest[] | undefined;
  // Arming only ever happens on the land path — either inside land() itself
  // (armTrigger) or through the host's seam right after it. With no `land`,
  // the automation was authored and handed back UNSTORED, so nothing armed it
  // and it is not enabled: claiming otherwise would put a live-looking card in
  // the thread for a trigger that does not exist in any row.
  let enabled = false;
  let armingIssues: string[] = [];
  if (deps.land !== undefined) {
    await deps.land(landed, { armTrigger: deps.armAutomation === undefined });
    const armed = await armAutomationTrigger(deps.armAutomation, deps.appId, triggerId, deps.ctx);
    pendingGrants = armed.pendingGrants;
    enabled = armed.enabled;
    armingIssues = armed.issues;
    findings.push(...armed.issues.map((issue) => warn(where, issue)));
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
 * What the box is told — the bind-after-build law in one function.
 *
 * The brief is the ESCALATED PLAN plus the person's own words, and nothing was
 * re-planned to produce either: the plan is the file the escalating agent wrote
 * and the person is already watching its skeleton, and the ask is what they
 * typed. (The app's own MEMORY joins them one layer down, where every box task
 * gets it — `editServerViaBox` in the runtime.)
 *
 * The box hears WHY the work cannot happen in the browser and WHAT the app
 * intends to show; it never hears a function name, a signature, or a shape to
 * implement. It decides its own interface, verifies its own code, and reports
 * what it actually serves. A pre-declared signature here would be the app
 * binding to a promise, and every mismatch afterwards would be invisible.
 */
const boxInstruction = (plan: AppPlan, server: PlanServer, deps: ServerLaneDeps): string => {
  const waiting = plan.groups
    .filter(({ waitsForServer }) => waitsForServer === true)
    .flatMap(({ leaves }) => leaves.map(({ purpose }) => purpose));
  const ask = deps.request?.trim();
  return [
    `Build the server work this app needs, then report what you built.`,
    `APP: ${plan.name}`,
    ...(ask === undefined || ask === "" ? [] : [`WHAT THEY ASKED FOR, IN THEIR OWN WORDS: ${ask}`]),
    `WHY THIS CANNOT HAPPEN IN THE BROWSER: ${server.why}`,
    ...(server.schedule === undefined ? [] : [`WHEN IT RUNS: ${server.schedule}`]),
    ...(deps.planText === undefined || deps.planText.trim() === "" ? [] : [
      `THE PLAN THIS BUILD IS ANCHORED ON (already on the person's screen as an outline):\n${deps.planText.trim()}`,
    ]),
    ...(waiting.length === 0 ? [] : [
      `WHAT THE APP INTENDS TO SHOW FROM IT (intent, NOT an interface to match — you decide the functions):\n${waiting.map((purpose) => `- ${purpose}`).join("\n")}`,
    ]),
    `Nothing in this app has been written against your code yet: no function name, no argument, and no result shape has been decided for you. Write whatever the job needs, verify it by running it, and report the interface you ended up serving — each function's name plus a REAL sample of its output. The app is wired to what you report, so report exactly what exists.`,
  ].join("\n");
};

const runBoxArm = async (
  plan: AppPlan,
  document: GeneratedAppDocument,
  deps: ServerLaneDeps,
): Promise<ServerLaneResult> => {
  const server = plan.server as PlanServer;
  const where = "server (box)";
  const box = deps.box;
  if (box === undefined || !box.available()) {
    // The plan should never have reached here — laneGates() states this host's
    // missing lanes as fact before planning — so this is the backstop, and it
    // still costs nothing: no machine is provisioned.
    return {
      document,
      findings: [warn(where, "this app's plan asked for custom server code, but this host cannot provision a machine (no sandbox adapter, or machine-backed execution disabled) — the app stands without it.")],
    };
  }
  await box.provision();
  const outcome = await box.instruct(boxInstruction(plan, server, deps));
  if (!outcome.ok) {
    // The machine is already discarded without a snapshot (the box seam's
    // rollback), so there is nothing to inherit and nothing to undo here: the
    // document never changed.
    return {
      document,
      findings: [warn(where, `the in-box agent could not build the server work: ${outcome.summary} — the machine was discarded, the rest of the app stands, and the sections that waited on it have nothing to show.`)],
    };
  }
  const functions = (outcome.functions ?? []).map((fn) => structuredClone(fn) as ServerFunction);
  const servesUi = outcome.servesUi === true;
  // A served app is allowed to name no functions — its pages ARE the interface —
  // so the missing-functions warning only applies to a plain layer-2 box.
  const bare = functions.length === 0 && !servesUi;
  return {
    document,
    findings: bare ? [
      warn(where, `the box reported building the server work (${outcome.summary}) but named no functions, so the sections that waited on it have nothing to bind to.`),
    ] : [],
    server: {
      summary: outcome.summary,
      functions,
      ...(outcome.servesUi === undefined ? {} : { servesUi: outcome.servesUi }),
      ...(outcome.servedOk === undefined ? {} : { servedOk: outcome.servedOk }),
    },
  };
};

/**
 * Which lane an ESCALATED plan runs in — the `<Server kind>` the escalating
 * agent declared, or the box.
 *
 * The tag is the whole decision and nothing re-derives it: the agent that could
 * not assemble the screen is the one that knows why, and it says so in the plan
 * (`<Server kind="steps"|"agentic"|"box" [served] why="…"/>`, taught by the
 * building-apps skill).
 *
 * A plan with NO `<Server>` that escalated anyway defaults to `kind="box"`. The
 * escalation is itself the claim that assembly cannot serve this ask, and the box
 * is the only lane that can find out what can: steps and agentic author an
 * automation over tools that assembly already had, so a plan that needed only
 * those would not have had to leave. Defaulting the other way would answer an
 * escalation with the rung it already ruled out.
 */
export const escalatedServer = (plan: AppPlan, why: string): PlanServer =>
  plan.server ?? { kind: "box", why };

/**
 * Run the server work the plan declared. `steps` and `agentic` author an
 * automation on the existing automations engine (seconds, no machine); `box`
 * provisions a machine and lets the in-box agent write real code, then reports
 * back the interface it built.
 */
export const runServerLane = async (
  plan: AppPlan,
  document: GeneratedAppDocument,
  deps: ServerLaneDeps,
): Promise<ServerLaneResult> => {
  const server = plan.server;
  if (server === undefined) return { document, findings: [] };
  return server.kind === "box"
    ? runBoxArm(plan, document, deps)
    : runAutomationArm(plan, document, deps, server.kind);
};
