/**
 * The rare lanes (generation pipeline rebuild, Task 8): the two things a plan
 * can declare that no fill worker can write — a generated ISLAND, and SERVER
 * work.
 *
 * Both are EARNED escapes. The brain decided in the plan that a component
 * cannot express the need, or that the work cannot happen in the browser;
 * these runners just execute what it declared. Nothing here re-judges the
 * escape, and nothing here rebuilds the machinery it drives: island source is
 * screened by `prepareIslands` and the smoke render, automations ride
 * `planAutomation` and the automations engine's own arming, and the box is the
 * existing machine lifecycle plus the in-box agent.
 *
 * The box lane is where the bind-after-build law lives: NOTHING pre-declares
 * the functions a box will serve. The lane hands the box the plan's reason and
 * the app's intent, the box writes whatever code the job needs, and only then
 * does it report the interface it actually serves — with real sampled output.
 * The groups the plan marked `waitsForServer` fill against those samples. A
 * pre-declared signature would be the app promising something no one has
 * written yet.
 *
 * Every failure here is SECTION-sized, never app-sized: a failed island or a
 * failed box comes back as `warn` findings with the document unchanged, and the
 * rest of the app stands.
 */
import {
  DEFAULT_TRIGGER_ID,
  TRIGGER_ID_PATTERN,
  compileWire,
  describeShapeWithSemantics,
  type AppDocument,
  type AppId,
  type AppPlan,
  type ApprovalRequest,
  type Json,
  type PlanIsland,
  type PlanServer,
  type RunContext,
  type Trigger,
} from "@vendoai/core";
import { planAutomation, type AutomationPlan } from "../automation-plan.js";
import type { Finding } from "../checking/types.js";
import { composePromptSections, hostToolSections, islandContract } from "./contracts/sections.js";
import { askModel, type GeneratedAppDocument, type GenerationDependencies } from "./engine.js";
import { prepareIslands } from "./validation/islands.js";
import { smokeRenderIslands } from "./validation/smoke-render.js";
import { wireCompileOptionsFor } from "../wire-options.js";

/** What a lane leaves behind. `document` is byte-identical to the input when
 *  the lane failed honestly — a lane never ships half of itself. */
export interface LaneResult {
  document: GeneratedAppDocument;
  findings: Finding[];
}

const warn = (where: string, message: string): Finding => ({ severity: "warn", where, message });

// ---------------------------------------------------------------------------
// Flag gating — stated as fact BEFORE the plan exists
// ---------------------------------------------------------------------------

/** The slice of `AppsConfig` the gates read (structurally satisfied by it; the
 *  lanes never import the runtime). */
export interface LaneGateConfig {
  experimentalMachines?: boolean;
  /** The machine seams. No sandbox adapter → nothing can be provisioned at
   *  all, flag or no flag. */
  machine?: { sandbox?: unknown };
  /** Build contract §9.8 — the authenticated door a served app is answered on.
   *  Unset means this deployment has no way to serve one, so the served lane is
   *  shut: the alternative is a box built, a surface flipped, and an app no
   *  caller can open. */
  servedProxyPath?: unknown;
}

export interface LaneGates {
  /** May a plan declare `server.kind: "box"`? */
  box: boolean;
  /** May this host serve the app surface from a machine (layer 3)? */
  served: boolean;
  /**
   * What the brain hears as FACT before it plans. A lane this host does not
   * have must become a `<Cannot>` line in the plan — an honest refusal the
   * person reads in seconds — instead of a build that runs, escalates, and
   * only then discovers the flag is off.
   */
  cannot: string[];
}

/**
 * What a machine-less host still HAS, said in the same breath as what it lacks.
 *
 * Only the box rung needs a machine: a steps firing is tool calls on the
 * automations engine and an agentic firing is one harness run on the agents
 * runtime. Stating the missing lane without this sentence is why "watch this and
 * judge it every morning" came back as "This host has no sandbox configured" —
 * the brain had one escape left for judgment work and it was the one that needs
 * a machine.
 */
const AUTOMATIONS_NEED_NO_MACHINE = 'Scheduled or triggered work still runs on the automations engine and needs no machine: kind="steps" when every firing does the same thing, kind="agentic" when a firing needs a judgment call.';

/**
 * The lanes this host actually has. Task 10's brain-facts assembly passes
 * `cannot` into the plan call, so "this host has machines disabled" is
 * something the brain KNOWS rather than something it finds out afterwards.
 */
export const laneGates = (config: LaneGateConfig): LaneGates => {
  const sandbox = config.machine?.sandbox !== undefined;
  const box = sandbox && config.experimentalMachines === true;
  // Layer 3 is a machine surface served through an authenticated door, so served
  // is a NARROWING of box: no box can never be served, and a box with no door to
  // serve through cannot either. Stated as the shape of the expression rather
  // than as two flags that have to agree with each other.
  const served = box && config.servedProxyPath !== undefined;
  const cannot: string[] = [];
  if (!sandbox) {
    cannot.push(`This host has no sandbox configured, so no machine can be provisioned: custom server code is out of reach. ${AUTOMATIONS_NEED_NO_MACHINE}`);
  } else if (config.experimentalMachines !== true) {
    cannot.push(`This host has machines disabled, so custom server code cannot run for it. ${AUTOMATIONS_NEED_NO_MACHINE}`);
  }
  if (!served) {
    cannot.push("This host cannot serve its own web pages for an app: the app is the generated view, so anything that needs a hand-built page or a custom frontend is out of reach.");
  }
  return { box, served, cannot };
};

// ---------------------------------------------------------------------------
// The island lane
// ---------------------------------------------------------------------------

export interface IslandLaneDeps extends GenerationDependencies {
  /** The person's own words. Threaded into the island law-1 scan so their own
   *  numbers are never refused as invented data (see prepareIslands). */
  request?: string;
}

/** One retry, and only one. An island that fails its screening twice is a real
 *  failure; a third big-model call costs the person time for a class the second
 *  attempt already reproduced (the brain's rule, same reason). */
const ISLAND_ATTEMPTS = 2;

const hostComponentNames = (deps: GenerationDependencies): string[] =>
  deps.catalog.map(({ name }) => name);

const islandLaneContract = (deps: IslandLaneDeps): string => composePromptSections([{
  id: "role",
  content: "You are the Vendo island specialist. The app's plan asked for ONE generated component because no host, Kit, or prewired component can express what it needs. Write that component and nothing else: reply with exactly one <Island name=\"...\">TSX</Island> element — the name you are given — with no prose, no markdown fences, no <App> wrapper, and no other markup.",
}, {
  id: "tree-contract",
  content: islandContract(),
}, ...hostToolSections(deps)]);

/** The queries this island's own leaves read. An island binds against REAL
 *  shapes or it invents fields, so the plan's own query declarations — tool,
 *  input, and sampled shape card — travel with the purpose. */
const islandQueryLines = (plan: AppPlan, island: PlanIsland, deps: IslandLaneDeps): string[] => {
  const referenced = new Set(plan.groups.flatMap(({ leaves }) => leaves
    .filter((leaf) => leaf.component === island.name && leaf.query !== undefined)
    .map((leaf) => leaf.query as string)));
  return plan.queries.filter(({ id }) => referenced.has(id)).map(({ id, tool, input }) => {
    const shape = deps.toolShapes?.[tool];
    const card = shape === undefined ? "shape unknown" : describeShapeWithSemantics(shape, deps.semantics?.[tool] ?? {});
    return `- ${id}: ${tool}(${JSON.stringify(input)}) → ${card}`;
  });
};

const islandLaneMessage = (
  plan: AppPlan,
  island: PlanIsland,
  deps: IslandLaneDeps,
  previous: { source: string; issues: string[] } | undefined,
): string => {
  const queries = islandQueryLines(plan, island, deps);
  return [
    `APP: ${plan.name}`,
    `ISLAND: ${island.name}`,
    `WHAT IT IS FOR: ${island.purpose}`,
    ...(queries.length === 0 ? [] : [`THE DATA IT SHOWS (the plan's queries this island reads — bind against these fields, never invent one):\n${queries.join("\n")}`]),
    ...(previous === undefined ? [] : [
      `YOUR LAST ISLAND DID NOT PASS:\n${previous.source}`,
      `WHAT WAS WRONG WITH IT:\n${previous.issues.map((issue) => `- ${issue}`).join("\n")}\nWrite the whole island again, fixed.`,
    ]),
  ].join("\n\n");
};

/** The island source out of one answer. Models wrap bare elements in fences or
 *  an <App> anyway, and the wire compiler extracts islands from either shape —
 *  the same tolerance the engine's island repair relies on. */
const islandSourceFrom = (text: string, name: string, deps: IslandLaneDeps): string | undefined => {
  const markup = text.replaceAll(/```[a-z]*\n?/gi, "");
  const start = markup.indexOf("<App");
  const close = markup.lastIndexOf("</App>");
  const wire = start !== -1 && close > start
    ? markup.slice(start, close + "</App>".length)
    : `<App name="__island_lane__">${markup}</App>`;
  const compiled = compileWire(wire, wireCompileOptionsFor(deps));
  const source = compiled.components[name];
  return typeof source === "string" && source.trim() !== "" ? source : undefined;
};

/** The screening every island in the product goes through, in the same order
 *  create validation runs it: the static contract first (imports, network,
 *  host tags, law 1, the tools manifest), then — only on an otherwise-clean
 *  island — one headless render, which is the only thing that sees a crash. */
const screenIsland = async (
  name: string,
  source: string,
  deps: IslandLaneDeps,
): Promise<{ source: string; tools: string[]; issues: string[] }> => {
  const prepared = await prepareIslands({ [name]: source }, deps.tools, hostComponentNames(deps), deps.request);
  const canonical = prepared.components[name] ?? source;
  const tools = prepared.componentTools[name] ?? [];
  if (prepared.issues.length > 0) return { source: canonical, tools, issues: prepared.issues };
  const issues = deps.pipeline?.smokeRender === false ? [] : await smokeRenderIslands({
    components: { [name]: canonical },
    componentTools: prepared.componentTools,
    tools: deps.tools,
    toolShapes: deps.toolShapes,
  });
  return { source: canonical, tools, issues };
};

/**
 * Write the island the plan declared, screen it, and stamp it onto the
 * document. A screening failure buys exactly one fix-it retry carrying the
 * issues; after that the app ships WITHOUT the island and says why — a broken
 * island renders as an error box where a section should be, which is worse
 * than a missing section.
 */
export const runIslandLane = async (
  plan: AppPlan,
  document: GeneratedAppDocument,
  deps: IslandLaneDeps,
): Promise<LaneResult> => {
  const island = plan.island;
  if (island === undefined) return { document, findings: [] };
  const where = `island "${island.name}"`;
  const system = islandLaneContract(deps);
  let previous: { source: string; issues: string[] } | undefined;
  for (let attempt = 0; attempt < ISLAND_ATTEMPTS; attempt += 1) {
    const answer = await askModel(deps.model, system, islandLaneMessage(plan, island, deps, previous));
    if (answer.text === undefined) {
      // A failed call is not a bad island: there is nothing to show on a
      // retry, so the reason stands as the failure.
      return { document, findings: answer.issues.map((issue) => warn(where, issue)) };
    }
    const source = islandSourceFrom(answer.text, island.name, deps);
    if (source === undefined) {
      previous = {
        source: answer.text,
        issues: [`no island came through: reply with exactly one <Island name="${island.name}">TSX</Island> element holding plain TSX with an \`export default\` component, and nothing else.`],
      };
      continue;
    }
    const screened = await screenIsland(island.name, source, deps);
    if (screened.issues.length === 0) {
      return {
        document: {
          ...document,
          components: { ...document.components, [island.name]: screened.source },
          componentTools: { ...document.componentTools, [island.name]: screened.tools },
        },
        findings: [],
      };
    }
    previous = { source: screened.source, issues: screened.issues };
  }
  return {
    document,
    findings: (previous?.issues ?? []).map((issue) => warn(where, issue)),
  };
};

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
   * Rewire the app to surface something new (the automation's results rows).
   * Task 10 wires this to a brain edit turn. Absent → the automation still
   * arms and the missing board is a `warn`, exactly as a failed rewire is.
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
 * What the box is told — the bind-after-build law in one function. The box
 * hears WHY the work cannot happen in the browser and WHAT the app intends to
 * show; it never hears a function name, a signature, or a shape to implement.
 * It decides its own interface, verifies its own code, and reports what it
 * actually serves. A pre-declared signature here would be the app binding to a
 * promise, and every mismatch afterwards would be invisible.
 */
const boxInstruction = (plan: AppPlan, server: PlanServer): string => {
  const waiting = plan.groups
    .filter(({ waitsForServer }) => waitsForServer === true)
    .flatMap(({ leaves }) => leaves.map(({ purpose }) => purpose));
  return [
    `Build the server work this app needs, then report what you built.`,
    `APP: ${plan.name}`,
    `WHY THIS CANNOT HAPPEN IN THE BROWSER: ${server.why}`,
    ...(server.schedule === undefined ? [] : [`WHEN IT RUNS: ${server.schedule}`]),
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
  const outcome = await box.instruct(boxInstruction(plan, server));
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
 * Run the server work the plan declared. `steps` and `agentic` author an
 * automation on the existing automations engine (seconds, no machine); `box`
 * provisions a machine and lets the in-box agent write real code, then reports
 * back the interface it built so the waiting groups can bind to it.
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
