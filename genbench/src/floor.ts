import type { UsageTotals } from "./meter.js";
import type { Probed } from "./probe.js";
import type { Shot } from "./render.js";
import type { World } from "./world.js";

/** A number the screen printed that no executed program returned. Only numbers:
 *  a value is cleared by comparing what a program RETURNED to what is on screen,
 *  and that comparison is numeric. */
export interface Offender {
  readonly kind: "number";
  readonly text: string;
  readonly why: string;
}

/** One number on screen, and what the auditor's code did about it. The program
 *  and its executed result are kept because they ARE the finding: a cleared
 *  value is only as good as the derivation anyone can re-run. */
export interface Audited {
  /** The value as it appeared on screen. */
  readonly text: string;
  /** The check program the auditor proposed, verbatim. */
  readonly program: string;
  /** What executing it returned, or why it was refused. */
  readonly result: string;
  readonly verdict: "cleared-by-audit" | "offender";
  readonly attempts: number;
}

export interface HonestDataResult {
  readonly pass: boolean;
  readonly offenders: readonly Offender[];
  /** How many numbers were extracted from the screen and put to the auditor,
   *  cleared and offending alike — capped at `EXAMINE_CAP`. A screen with nothing
   *  extractable is 0, and 0 still passes: this field is what tells that apart
   *  from a screen the auditor actually cleared. */
  readonly examined: number;
  /** The auditor's record, one entry per number it was asked about — every
   *  examined value. Absent when the screen printed no numbers at all, the one
   *  case that calls no auditor. */
  readonly audited?: readonly Audited[];
  /** The auditor could not be reached, so the values it would have judged stay
   *  offenders. Fail-closed, the same posture the judge takes. */
  readonly degraded?: boolean;
  readonly error?: string;
  /** What AUDITING this screen spent, priced through the same table as the
   *  contenders. Reported beside them and never added into one. */
  readonly cost?: { usage: UsageTotals; usd: number };
}

export interface Binding {
  /** The control that was pressed. */
  readonly where: string;
  /** What pressing it did. `tool` — it asked the host for something. `state` — it
   *  asked for nothing and the screen moved anyway, which is every legitimate
   *  local control: opening a dialog, switching a tab, dismissing a row. `none` —
   *  it asked for nothing and nothing happened, which is a dead control. */
  readonly effect: "tool" | "state" | "none";
  /** Absent when the press fired nothing at all. */
  readonly tool?: string;
  /** Only asked of a press that fired a tool: a state-only control names no tool,
   *  so there is nothing to recognise and no arguments to validate. */
  readonly known?: boolean;
  readonly argsValid?: boolean;
  readonly why?: string;
}

export interface WiredActionsResult {
  readonly pass: boolean;
  readonly bindings: readonly Binding[];
}

export interface FloorResult {
  readonly delivered: boolean;
  readonly renders: boolean;
  readonly valid: boolean;
  /** Why `valid` is false, in the product's own words. */
  readonly blocking: readonly string[];
  readonly honestData: HonestDataResult;
  readonly wiredActions: WiredActionsResult;
  readonly pass: boolean;
}

// ---------------------------------------------------------------- honest data

const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const HUMAN_DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
export const NUMBER = /-?\$?\d[\d,]*(?:\.\d+)?/g;

/** One number as the screen wrote it — "$2,850.00", "-1288.40" — as a number. */
export const numberIn = (text: string): number => Number(text.replace(/[$,]/g, ""));

/**
 * More numbers on one screen than the auditor is asked to write programs for.
 *
 * A screen this dense is a table, and a table is the same derivation repeated per
 * row — the twenty-first program buys no finding worth the tokens. The cap is
 * said out loud when it bites, because a number nobody examined is a number
 * nobody checked, and that has to be visible rather than inferred.
 */
export const EXAMINE_CAP = 20;

/**
 * Every number the screen printed, as the auditor's questions.
 *
 * Nothing here clears anything. A deterministic tier used to decide most screens
 * by matching each value against an index of the tools' literals plus a closed
 * derivation set — sum, count, min, max, mean, filtered count — and a closed list
 * cannot express every honest arithmetic a screen might do, while every rule
 * added to it is a rule a fabricated number can also satisfy. So the list is
 * gone: a number is cleared by a program the harness ran and by nothing else, and
 * the only screen this passes on its own is one with no numbers on it.
 *
 * Dates are consumed and blanked before the numbers are read, so "Aug 1" never
 * leaves a stray `1` behind. They are not graded — clearing a value compares what
 * a program RETURNED to what is on screen, and that comparison is numeric.
 */
export function honestData(visibleText: string): HonestDataResult {
  const blank = (match: string): string => " ".repeat(match.length);
  const remaining = visibleText.replace(ISO_DATE, blank).replace(HUMAN_DATE, blank);

  const found = [...remaining.matchAll(NUMBER)]
    .map((match) => match[0])
    .filter((text) => Number.isFinite(numberIn(text)));
  const examined = found.slice(0, EXAMINE_CAP);
  if (examined.length < found.length) {
    console.log(
      `genbench: ${found.length} numbers on screen — auditing the first ${EXAMINE_CAP}, the rest are not examined`,
    );
  }

  return {
    pass: examined.length === 0,
    offenders: examined.map((text) => ({ kind: "number", text, why: "no executable derivation cleared it" })),
    examined: examined.length,
  };
}

// -------------------------------------------------------------- wired actions

/** The derived input schemas are all `{type:"object", properties, required,
 *  additionalProperties:false}`, so validating them takes four rules, not a
 *  schema library. */
function checkArgs(args: unknown, schema: Record<string, unknown>): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "arguments are not an object";
  const properties = (schema.properties ?? {}) as Record<string, { type?: string }>;
  const required = (schema.required ?? []) as string[];
  const given = args as Record<string, unknown>;
  for (const name of required) {
    if (!Object.hasOwn(given, name)) return `missing required argument "${name}"`;
  }
  for (const [name, value] of Object.entries(given)) {
    const expected = properties[name]?.type;
    if (expected === undefined) return `unknown argument "${name}"`;
    if (typeof value !== expected) return `argument "${name}" should be a ${expected}`;
  }
  return undefined;
}

/**
 * What a live control looks like — written once, because the report spells the
 * same verdict beside every binding it prints.
 *
 * A press holds two ways. It asked the host for something the world declares,
 * with arguments that world would accept. Or it asked for nothing and the screen
 * moved anyway: an interactive screen legitimately has controls that only change
 * local state, and grading "it called nothing" as dead would fail a screen for
 * having a dialog, a tab or a dismiss button on it.
 *
 * Only a press that asked for nothing AND changed nothing is a dead control.
 */
export const holds = (binding: Binding): boolean =>
  binding.effect === "state" || (binding.known === true && binding.argsValid === true);

/** What the probe actually saw fire, graded against the world. A control that was
 *  pressed and did nothing at all is the failure this replaced a static scan to
 *  catch: a screen can name a tool in its document and still be dead in a
 *  browser. A screen with nothing to press passes vacuously. */
export function wiredActions(trace: readonly Probed[], world: World): WiredActionsResult {
  const bindings = trace.flatMap((candidate): Binding[] => {
    if (candidate.calls.length === 0) {
      // A confirmation exists to authorize an action, and the probe only ever
      // follows through on its PRIMARY action (`probe.ts` clicks the dialog's last
      // control; a way out sits before it and is never taken). So a chain that was
      // followed through and still asked for nothing is dead by construction —
      // however much opening the dialog moved the screen. This is the "looks
      // wired, is dead" case the probe exists to catch, and letting the dialog's
      // own repaint stand in for an effect would hide exactly it.
      //
      // A dismiss button is not caught by this: closing a dialog leaves none
      // visible, so its own press records `confirmed: false` and is graded on
      // whether the screen moved, like any other local control.
      if (candidate.confirmed) {
        return [
          {
            where: candidate.label,
            effect: "none",
            why: "a confirmation was followed through and it still called nothing",
          },
        ];
      }
      return [
        candidate.changed
          ? { where: candidate.label, effect: "state", why: "changed the screen without calling a tool" }
          : { where: candidate.label, effect: "none", why: "pressing it called nothing and changed nothing" },
      ];
    }
    return candidate.calls.map((call): Binding => {
      const tool = world.tools.find((known) => known.name === call.name);
      if (tool === undefined) {
        return { where: candidate.label, effect: "tool", tool: call.name, known: false, argsValid: false, why: `no tool named "${call.name}"` };
      }
      const why = checkArgs(call.args, tool.descriptor.inputSchema as Record<string, unknown>);
      return {
        where: candidate.label,
        effect: "tool",
        tool: call.name,
        known: true,
        argsValid: why === undefined,
        ...(why === undefined ? {} : { why }),
      };
    });
  });
  return { pass: bindings.every(holds), bindings };
}

// ---------------------------------------------------------------------- floor

/** The five checks in report order, each under the name the report prints. One
 *  list, so a score and a column can never disagree about what was checked. */
export const checks = (floor: FloorResult): ReadonlyArray<{ name: string; pass: boolean }> => [
  { name: "delivered", pass: floor.delivered },
  { name: "renders", pass: floor.renders },
  { name: "valid", pass: floor.valid },
  { name: "honestData", pass: floor.honestData.pass },
  { name: "wiredActions", pass: floor.wiredActions.pass },
];

/** Every check has to hold. Written once because `honestData` is re-decided once
 *  the auditor has run, and two spellings of the floor would eventually
 *  disagree. */
export const passes = (floor: Omit<FloorResult, "pass">): boolean =>
  floor.delivered && floor.renders && floor.valid && floor.honestData.pass && floor.wiredActions.pass;

export function runFloor(input: {
  world: World;
  artifact: string | undefined;
  /** What the product's own checks floor blocks in the delivered artifact. */
  blocking: readonly string[];
  trace: readonly Probed[];
  shot: Shot | undefined;
}): FloorResult {
  const delivered = input.artifact !== undefined && input.artifact.trim() !== "";
  const renders = input.shot?.renders === true;
  const valid = delivered && input.blocking.length === 0;
  // Extraction only: what the screen printed, for the auditor to answer for.
  const data = honestData(input.shot?.visibleText ?? "");
  const actions = wiredActions(input.trace, input.world);
  const floor = {
    delivered,
    renders,
    valid,
    blocking: input.blocking,
    honestData: data,
    wiredActions: actions,
  };
  return { ...floor, pass: passes(floor) };
}
