/**
 * The server lane: the one thing a plan can declare that assembly cannot write —
 * work that does not happen in the browser.
 *
 * It is an EARNED escape. The escalating agent decided in its plan that the work
 * cannot happen in the browser; this runner just executes what the plan declared.
 * Nothing here re-judges the escape, and nothing here rebuilds the machinery it
 * drives: the box is the existing machine lifecycle plus the in-box agent.
 *
 * There is exactly ONE lane left. Authoring an automation never needed a
 * machine, so it is a door of its own now (`server/automation/lane.ts`) rather
 * than a rung of the ladder that reaches for one.
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
  type AppId,
  type Json,
  type RunContext,
} from "@vendoai/core";
import {
  type AppPlan,
  type PlanServer,
} from "../../contract/index.js";
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
  /** The stored app's id — the machine the lane provisions belongs to it. */
  appId: AppId;
  ctx: RunContext;
  /** The person's own words for this change: the box hears the ask verbatim
   *  beside the plan it is building. */
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
  box?: BoxSeam;
}

export interface ServerLaneResult extends LaneResult {
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
    // The plan should never have reached here — the planner is told this host's
    // missing lanes as fact — so this is the backstop, and it still costs
    // nothing: no machine is provisioned.
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
 * The lane an ESCALATED plan runs in: the box.
 *
 * The `<Server>` tag the escalating agent wrote is still the plan's own words
 * about the away work — `why`, and `served` for the layer-3 claim — and a plan
 * with NO `<Server>` that escalated anyway means the box just the same. The
 * escalation IS the claim that assembly cannot serve this ask, and the box is
 * the only lane that can find out what can.
 */
export const escalatedServer = (plan: AppPlan, why: string): PlanServer =>
  plan.server ?? { kind: "box", why };

/**
 * Does this escalation need a MACHINE?
 *
 * The one expression create and edit both gate on. They used to disagree —
 * create refused EVERY escalation on a host with no sandbox, edit refused only
 * a box — so an automation you could ask for by editing an app you could not
 * ask for by making one. Two rungs and one door: only the box rung needs a
 * machine, and both doors read that off the same function.
 */
export const escalationNeedsMachine = (server: PlanServer): boolean => server.kind === "box";

/**
 * Run the server work the plan declared: provision a machine, let the in-box
 * agent write real code against the plan itself, and report back the interface
 * it built. Authoring an automation is not here — it is its own door
 * (`server/automation/lane.ts`), because it never needed a machine.
 */
export const runServerLane = async (
  plan: AppPlan,
  document: GeneratedAppDocument,
  deps: ServerLaneDeps,
): Promise<ServerLaneResult> => {
  if (plan.server === undefined) return { document, findings: [] };
  return runBoxArm(plan, document, deps);
};
