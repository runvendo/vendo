/**
 * The harness lane's case shape, and the verdicts a recorded conversation
 * decides on its own.
 *
 * Nothing in this file talks to a model or to the product. It reads a TRACE —
 * every user ask, every reply, and every tool call the runtime mirrored onto the
 * wire, with the arguments and the outcome each one got — and answers yes or no.
 * That is the whole score for this lane: the judge (harness-judge.ts) grades
 * tone and completeness on top of it and never decides the exit code, exactly as
 * the screen lane's floor and judge divide.
 */
import { buildIndex, honestData, type Offender } from "./floor.js";
import type { UsageTotals } from "./meter.js";
import type { World, WorldTool } from "./world.js";

/**
 * One tool's behaviour for one case.
 *
 * A name the world already has is AMENDED — `data` replaces its rows, `fail`
 * makes it answer with an error — and a name the world does not have is DEFINED
 * here, in the world file's own vocabulary (`does`, `takes`, `data`). Defining
 * it in the case rather than in `world.json` is deliberate: the world's hash is
 * every screen run's comparability stamp, and a tool that only one conversation
 * needs must not declare every recorded screen run incomparable.
 */
export interface HarnessTool extends Partial<WorldTool> {
  /** REQUIRED for a tool the world does not have, and never needed for one it
   *  does: amending a tool must not restate the description it already has. */
  readonly does?: string;
  /** Answer with an error: on the FIRST call only (the recovery case — the tool
   *  works once the agent tries again), or on every call. */
  readonly fail?: "first" | "always";
  /** What the failure says. Defaults to a 404-shaped not-found. */
  readonly error?: { readonly code: string; readonly message: string };
}

/** A call that must have happened, with the arguments that make it the RIGHT
 *  call. `args` is a subset: the keys named must match, and anything else the
 *  agent sent is its own business. */
export interface ExpectedCall {
  readonly tool: string;
  readonly args?: Readonly<Record<string, unknown>>;
}

export interface HarnessCase {
  readonly id: string;
  readonly kind: "harness";
  /** 1-3 user messages, sent in order down ONE thread — so turn 3 is graded
   *  with whatever the agent still remembers of turn 1. */
  readonly turns: readonly string[];
  readonly tools?: Readonly<Record<string, HarnessTool>>;
  /**
   * The write gate. Set, the guard asks before every write and the person
   * answers — immediately, this way — so a parked approval is a fact about the
   * conversation rather than a ninety-second wall-clock wait nobody taps.
   * Unset is autopilot: a write runs.
   */
  readonly gate?: "approve" | "deny";
  readonly expectCalls?: readonly ExpectedCall[];
  /** Tool names that must never be called — any name, the product's own verbs
   *  included, so "answer this, do not go and build an app for it" is sayable. */
  readonly forbidCalls?: readonly string[];
  /** The efficiency bound, counted over the HOST's tools only: a case that is
   *  answerable in two calls says 5 and a run that thrashes fails. The
   *  product's own verbs are not counted — they are the harness's overhead, and
   *  a bound that moved when the loadout rail changed would measure nothing. */
  readonly maxToolCalls?: number;
  /** The reply must be a QUESTION, not an action. */
  readonly mustAsk?: boolean;
  /** The reply must state no figure the tools did not actually return. Set on a
   *  case whose tools are made to fail, which is where an agent invents. */
  readonly mustAdmitFailure?: boolean;
  /** Text the final reply must contain — money and thousands separators
   *  normalised away, so "$1,050.65" satisfies "1050.65". */
  readonly mustSay?: readonly string[];
  /** The case's own rubric, graded blind on the transcript by the judge. */
  readonly pass?: readonly string[];
}

/** One tool call as the runtime mirrored it: what was called, with what, and
 *  what came back. The product's own record — the same events the thread UI
 *  renders — so a call the agent made cannot be missing from it. */
export interface RecordedCall {
  readonly tool: string;
  readonly args: unknown;
  readonly status: "ok" | "error" | "denied";
  readonly output?: unknown;
  /** The refusal or the error, in the product's words. */
  readonly why?: string;
}

export interface RecordedTurn {
  readonly ask: string;
  readonly reply: string;
  readonly calls: readonly RecordedCall[];
  readonly ms: number;
  readonly cost: { readonly usage: UsageTotals; readonly usd: number };
  /** This turn ended badly — a provider error, an abort, a budget. */
  readonly failure?: string;
}

export interface HarnessCheck {
  readonly name: string;
  readonly pass: boolean;
  /** What failed, in one clause. Present on a failure and on a pass that a
   *  reader would otherwise have to take on trust. */
  readonly why?: string;
}

const ASK_USER_TOOL = "ask_user";

/** Money and thousands separators are display choices; a needle should not have
 *  to guess which one the agent picked. */
const normalise = (text: string): string => text.replace(/[$,]/g, "").toLowerCase();

/** Every call of the conversation, in the order they happened. */
export const allCalls = (turns: readonly RecordedTurn[]): readonly RecordedCall[] =>
  turns.flatMap((turn) => turn.calls);

const argsMatch = (expected: Readonly<Record<string, unknown>>, actual: unknown): boolean => {
  if (typeof actual !== "object" || actual === null) return false;
  const given = actual as Record<string, unknown>;
  return Object.entries(expected).every(
    ([key, value]) => JSON.stringify(given[key]) === JSON.stringify(value),
  );
};

/**
 * Every expected call matched against a DISTINCT recorded call.
 *
 * Distinct is the mechanism: naming one tool twice is how a case says "it had to
 * list them again after the failure", and a matcher that let one call satisfy
 * both entries would pass a run that never retried.
 */
function unmatched(expected: readonly ExpectedCall[], calls: readonly RecordedCall[]): ExpectedCall[] {
  const spent = new Set<number>();
  const missing: ExpectedCall[] = [];
  for (const want of expected) {
    const found = calls.findIndex(
      (call, index) =>
        !spent.has(index) && call.tool === want.tool && (want.args === undefined || argsMatch(want.args, call.args)),
    );
    if (found === -1) missing.push(want);
    else spent.add(found);
  }
  return missing;
}

/**
 * The number index built from what the tools ACTUALLY answered with — the
 * floor's own index, over the outputs this conversation really received rather
 * than over the world file.
 *
 * That distinction is the whole check: when every call failed, the index is
 * empty, so any figure in the reply is one the agent made up. `buildIndex` reads
 * only each entry's `data`, which is why one call's output can stand in for a
 * tool here; it brings the same allowances a screen gets (a literal, a row
 * count, a sum/mean/min/max of one field, a filtered count), so an honest
 * arithmetic over a result that DID arrive is not called a lie.
 */
function receivedIndex(calls: readonly RecordedCall[]): ReturnType<typeof buildIndex> {
  const tools = calls
    .filter((call) => call.status === "ok" && call.output !== undefined)
    .map((call, index) => ({ name: `${call.tool}#${index}`, data: call.output }));
  return buildIndex({ tools } as unknown as World);
}

/**
 * A figure, as opposed to a number a sentence happens to contain.
 *
 * "I tried 2 times" is not a claim about the customer's money; "$1,050.65",
 * "941220" and a date are. Currency, a decimal point, a separator or three
 * digits is the line, and it is drawn on purpose: without it every ordinal and
 * every bullet number in an honest apology reads as fabrication.
 */
const isFigure = (offender: Offender): boolean =>
  offender.kind === "date" || /[$.,]/.test(offender.text) || offender.text.replace(/\D/g, "").length >= 3;

/**
 * Every verdict this case earned, in report order.
 *
 * `answered` is always here — a conversation that produced no reply is a failure
 * whatever else it did — and every other check is present only when the case
 * asked for it, so a column's checks are the case's own contract rather than a
 * fixed row of dashes.
 */
export function harnessChecks(input: {
  testCase: HarnessCase;
  turns: readonly RecordedTurn[];
  /** The host's own tools, which is what the efficiency bound counts. */
  worldTools: readonly string[];
}): readonly HarnessCheck[] {
  const { testCase, turns, worldTools } = input;
  const calls = allCalls(turns);
  const last = turns.at(-1);
  const reply = last?.reply ?? "";
  const checks: HarnessCheck[] = [];

  const broke = turns.find((turn) => turn.failure !== undefined);
  const silent = turns.find((turn) => turn.reply.trim() === "");
  checks.push({
    name: "answered",
    pass: broke === undefined && silent === undefined && turns.length === testCase.turns.length,
    ...(broke !== undefined
      ? { why: `turn ${turns.indexOf(broke) + 1} failed: ${broke.failure ?? ""}` }
      : silent !== undefined
        ? { why: `turn ${turns.indexOf(silent) + 1} said nothing` }
        : turns.length !== testCase.turns.length
          ? { why: `${turns.length} of ${testCase.turns.length} turns ran` }
          : {}),
  });

  if (testCase.expectCalls !== undefined) {
    const missing = unmatched(testCase.expectCalls, calls);
    checks.push({
      name: "expectedCalls",
      pass: missing.length === 0,
      ...(missing.length === 0
        ? {}
        : {
            why: `never called ${missing
              .map((want) => `${want.tool}(${want.args === undefined ? "" : JSON.stringify(want.args)})`)
              .join(", ")}`,
          }),
    });
  }

  if (testCase.forbidCalls !== undefined) {
    const banned = new Set(testCase.forbidCalls);
    const hit = calls.filter((call) => banned.has(call.tool));
    checks.push({
      name: "forbiddenCalls",
      pass: hit.length === 0,
      ...(hit.length === 0 ? {} : { why: `called ${[...new Set(hit.map((call) => call.tool))].join(", ")}` }),
    });
  }

  if (testCase.maxToolCalls !== undefined) {
    const hostCalls = calls.filter((call) => worldTools.includes(call.tool));
    checks.push({
      name: "toolBudget",
      pass: hostCalls.length <= testCase.maxToolCalls,
      why: `${hostCalls.length} host calls, budget ${testCase.maxToolCalls}`,
    });
  }

  if (testCase.mustAsk === true) {
    // Either door counts: the product's own question tool, which ENDS the turn,
    // or a question put in the reply's own words. A screen that guessed and
    // carried on has neither.
    const asked = (last?.calls ?? []).some((call) => call.tool === ASK_USER_TOOL);
    checks.push({
      name: "askedInstead",
      pass: asked || reply.includes("?"),
      ...(asked || reply.includes("?") ? {} : { why: "the reply asked nothing" }),
    });
  }

  if (testCase.mustAdmitFailure === true) {
    const offenders = honestData(reply, receivedIndex(calls)).offenders.filter(isFigure);
    checks.push({
      name: "noFabrication",
      pass: offenders.length === 0,
      ...(offenders.length === 0
        ? {}
        : { why: `stated ${offenders.map((offender) => offender.text).join(", ")} — no tool returned it` }),
    });
  }

  if (testCase.mustSay !== undefined) {
    const said = normalise(reply);
    const absent = testCase.mustSay.filter((needle) => !said.includes(normalise(needle)));
    checks.push({
      name: "saidRequired",
      pass: absent.length === 0,
      ...(absent.length === 0 ? {} : { why: `never said ${absent.join(", ")}` }),
    });
  }

  return checks;
}

export const harnessPasses = (checks: readonly HarnessCheck[]): boolean => checks.every((check) => check.pass);

/** The authored file, checked hard enough that a typo is a sentence rather than
 *  a case that quietly grades nothing. */
export function parseHarnessCases(source: string): readonly HarnessCase[] {
  const cases = JSON.parse(source) as HarnessCase[];
  if (!Array.isArray(cases)) throw new Error("genbench: a harness cases file is an array of cases");
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (testCase.kind !== "harness") {
      throw new Error(`genbench: case "${testCase.id}" is not kind "harness"`);
    }
    if (seen.has(testCase.id)) throw new Error(`genbench: duplicate case id "${testCase.id}"`);
    seen.add(testCase.id);
    if (!Array.isArray(testCase.turns) || testCase.turns.length === 0 || testCase.turns.length > 3) {
      throw new Error(`genbench: case "${testCase.id}" needs 1-3 turns`);
    }
    for (const [name, spec] of Object.entries(testCase.tools ?? {})) {
      // A tool the world does not have is defined by the case, and a definition
      // with no description is one the model cannot use.
      if (spec.does === undefined && spec.data === undefined && spec.fail === undefined) {
        throw new Error(`genbench: case "${testCase.id}" says nothing about tool "${name}"`);
      }
    }
  }
  return cases;
}
