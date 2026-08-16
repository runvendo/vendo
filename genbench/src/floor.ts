import type { UsageTotals } from "./meter.js";
import type { Probed } from "./probe.js";
import type { Shot } from "./render.js";
import { cannedResponse, type CaseTag, type World } from "./world.js";

/**
 * One token as it appeared at ONE place on the screen.
 *
 * Two tokens with the same characters in different surroundings are two
 * different questions: the `9` in "9:15 AM" is a clock and the `9` in "Total
 * count 9" is a claim about the data. So everything downstream of the extraction
 * keys off `at` and never off the text — a verdict reached about one occurrence
 * settles that occurrence and no other.
 */
export interface Occurrence {
  readonly text: string;
  /** Where it starts in the screen's visible text. */
  readonly at: number;
}

/** A number the screen printed that no executed program returned. Only numbers:
 *  a value is cleared by comparing what a program RETURNED to what is on screen,
 *  and that comparison is numeric. */
export interface Offender extends Occurrence {
  readonly kind: "number";
  readonly why: string;
}

/**
 * What settled one value on the screen.
 *
 * - `cleared-by-verbatim` — the tools answer with this exact text somewhere, so
 *   nothing had to decide anything and no model was called.
 * - `skipped-by-triage` — a model read the token in its own surroundings and said
 *   it is not a claim about the data at all (an id fragment, a clock time, an
 *   axis tick), with the clause it said it in.
 * - `cleared-by-audit` — a program the harness executed returned it.
 * - `offender` — none of the above held.
 */
export type HonestVerdict = "cleared-by-verbatim" | "skipped-by-triage" | "cleared-by-audit" | "offender";

/** One number on screen and what was done about it — every value, whichever
 *  stage settled it. The program and its executed result are kept because they
 *  ARE the finding: a cleared value is only as good as the derivation anyone can
 *  re-run, and a WAIVED value is only as good as the reason anyone can read. */
export interface Audited {
  /** The value as it appeared on screen. */
  readonly text: string;
  /** The check program the auditor proposed, verbatim. Empty when no program was
   *  asked for: a verbatim match and a triage waiver both settle without one. */
  readonly program: string;
  /** What executing it returned, why it was refused, or — where no program ran —
   *  the one clause that settled it. */
  readonly result: string;
  readonly verdict: HonestVerdict;
  /** Auditor proposals spent on it. 0 when it never reached the auditor. */
  readonly attempts: number;
  /** The surroundings this row is about, for the verdicts that are reached per
   *  OCCURRENCE — a triage waiver. Without it two waived `9`s are two identical
   *  rows and a reader cannot tell which one was let go. Absent on the verdicts
   *  that answer for the token wherever it appears: the tools' own text clears
   *  every copy, and one executed program answers for every copy. */
  readonly where?: string;
}

/** One OCCURRENCE, and what the triage said about it. Declared here beside the
 *  result it is carried in, so `triage.ts` can read the screen's own context
 *  helper without the two files importing each other. `why` is the model's own
 *  clause either way — a decision nobody can read is a decision nobody can
 *  overturn — and `where` is the surroundings it was reached in, which is the
 *  only thing that tells two verdicts about the same characters apart. */
export interface TriageDecision extends Occurrence {
  readonly claim: boolean;
  readonly why: string;
  readonly where: string;
}

export interface HonestDataResult {
  readonly pass: boolean;
  readonly offenders: readonly Offender[];
  /** How many numbers were extracted from the screen, whoever cleared them —
   *  capped at `EXAMINE_CAP`. A screen with nothing extractable is 0, and 0 still
   *  passes: this field is what tells that apart from a screen that was actually
   *  checked. */
  readonly examined: number;
  /** How many numbers the screen printed in total. It is only ever `examined`
   *  or more, and the gap is the part of the screen nobody looked at — said in
   *  `result.json` and in the preview rather than on stdout, where the cap was
   *  announced to a terminal nobody keeps. */
  readonly found: number;
  /** One entry per examined value, in the order the stages settled them: cleared
   *  verbatim, waived by triage, then everything the auditor wrote code for.
   *  Absent when the screen printed no numbers at all. */
  readonly audited?: readonly Audited[];
  /** The triage's whole answer, verbatim: every token it was shown, whether it
   *  called it a claim, and the clause it said it in. Kept beside the verdicts
   *  rather than folded into them, because a waiver is only auditable if what the
   *  model actually said is on the record. Absent when no triage ran. */
  readonly triage?: readonly TriageDecision[];
  /** A model this check leans on could not be reached, so nothing was waived or
   *  cleared on its word. Fail-closed, the same posture the judge takes. */
  readonly degraded?: boolean;
  readonly error?: string;
  /** What TRIAGING and AUDITING this screen spent, priced through the same table
   *  as the contenders. Reported beside them and never added into one. */
  readonly cost?: { usage: UsageTotals; usd: number };
  /** What the provider says actually answered: both contracts pin a floating
   *  alias, and the id we asked for is not the model that sorted or proved. */
  readonly modelVersion?: string;
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
  /** How many controls the probe found and pressed. A screen with nothing to
   *  press passes with 0, and 0 still passes: this is what tells that vacuous
   *  pass apart from a screen whose controls were all live, exactly as
   *  `honestData.examined` does for numbers. Not `bindings.length` — one press
   *  that fires two tools is two bindings, and a press that fires none is still
   *  one control that was pressed. */
  readonly pressed: number;
  readonly bindings: readonly Binding[];
  /** What cleared an `action` case's bar, and which of the two did it: a press
   *  that asked the host for something, or one that opened a confirmation the
   *  probe never presses inside. Absent when neither happened. */
  readonly acted?: "tool" | "confirmation";
  /** Why the check failed for a reason no single binding carries — an `action`
   *  case none of whose presses did either. */
  readonly why?: string;
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
/**
 * One token the screen printed, in the two shapes a digit group comes in.
 *
 * An IDENTIFIER first — a digit run behind a letter and a hyphen belongs to the
 * name in front of it. `J-2444` read as a number is `-2444`: a negative nobody
 * printed, that no honest program can return and that the anti-cheat then refuses
 * every attempt to select the row by its own id. It is one token with its prefix,
 * which is also what lets the tools' own text clear it without a model.
 *
 * Then a NUMBER, as broadly as before. Extraction does not classify — a triage
 * model does, with the surrounding screen in front of it — so a token that turns
 * out to be a duration or an axis tick is cut here and waived there, on the
 * record, rather than never being seen.
 */
export const NUMBER = /[A-Za-z][A-Za-z0-9]*(?:-\d[\d,]*)+|-?\$?\d[\d,]*(?:\.\d+)?/g;

/** One number as the screen wrote it — "$2,850.00", "-1288.40" — as a number. An
 *  identifier is not one, and answers `NaN`. */
export const numberIn = (text: string): number => Number(text.replace(/[$,]/g, ""));

/**
 * Enough of the screen around a value to tell a total from a percentage — read
 * by both models that are ever shown one, the triage and the auditor.
 *
 * `at` names WHICH occurrence to quote, defaulting to the first. The auditor
 * answers for a value wherever it appears and takes the default; the triage
 * judges one occurrence at a time and passes that occurrence's own offset, or
 * every copy of a token would be quoted in the first copy's surroundings — and
 * would then inherit the first copy's verdict.
 */
const CONTEXT_CHARS = 90;
export const around = (visibleText: string, value: string, at = visibleText.indexOf(value)): string => {
  if (at === -1) return "";
  return visibleText
    .slice(Math.max(0, at - CONTEXT_CHARS), at + value.length + CONTEXT_CHARS)
    .replace(/\s+/g, " ")
    .trim();
};

/**
 * More numbers on one screen than the auditor is asked to write programs for.
 *
 * A screen this dense is a table, and a table is the same derivation repeated per
 * row — the twenty-first program buys no finding worth the tokens. What the cap
 * left out rides on the result as `found`, because a number nobody examined is a
 * number nobody checked: said on a terminal it was a line that scrolled past,
 * and the pass it hid outlived it in `result.json`.
 */
export const EXAMINE_CAP = 20;

/** Every string the case's tools actually answer with. A screen may print one of
 *  these character for character — an id, an account mask, a status — and there
 *  is nothing left for anyone to decide about it. Strings only: a number the data
 *  holds as a number may be shown at either money scale, which is arithmetic and
 *  belongs to the auditor. */
function answeredText(world: World): ReadonlySet<string> {
  const said = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") said.add(value.trim());
    else if (Array.isArray(value)) for (const item of value) walk(item);
    else if (typeof value === "object" && value !== null) for (const item of Object.values(value)) walk(item);
  };
  for (const tool of world.tools) walk(cannedResponse(tool));
  return said;
}

/**
 * Every number the screen printed, and the one verdict that needs no model.
 *
 * A deterministic tier used to decide most screens by matching each value against
 * an index of the tools' literals plus a closed derivation set — sum, count, min,
 * max, mean, filtered count. A closed list cannot express every honest arithmetic
 * a screen might do, and every rule added to it is a rule a fabricated number can
 * also satisfy, so the list is gone.
 *
 * What is left here is the one clearing that cannot be gamed and cannot be
 * argued with: the token IS a string the tools answered with. `J-2444` on a job
 * card is the id in the row, spelled the same way — no derivation, no attempt, no
 * call. Everything else leaves this function unproven, for the triage to sort and
 * the auditor to answer for.
 *
 * Dates are consumed and blanked before the numbers are read, so "Aug 1" never
 * leaves a stray `1` behind. They are not graded — clearing a value compares what
 * a program RETURNED to what is on screen, and that comparison is numeric.
 */
export function honestData(visibleText: string, world: World): HonestDataResult {
  const blank = (match: string): string => " ".repeat(match.length);
  const remaining = visibleText.replace(ISO_DATE, blank).replace(HUMAN_DATE, blank);

  // Each token keeps the offset it was cut from. `remaining` blanks dates with
  // the SAME number of spaces they occupied, so an offset into it is an offset
  // into `visibleText` — which is what lets the triage quote each occurrence in
  // its own surroundings later.
  const found = [...remaining.matchAll(NUMBER)]
    .map((match): Occurrence => ({ text: match[0], at: match.index }))
    // An identifier is a token the auditor answers for as text, so it is kept
    // even though it is not a finite number.
    .filter(({ text }) => /[A-Za-z]/.test(text) || Number.isFinite(numberIn(text)));
  const examined = found.slice(0, EXAMINE_CAP);

  const said = answeredText(world);
  // The verbatim clearing is the one verdict that needs no surroundings — the
  // tools answer with those exact characters wherever they appear — so it stays
  // one row per distinct text.
  const verbatim = [...new Set(examined.filter(({ text }) => said.has(text.trim())).map(({ text }) => text))];
  const unproven = examined.filter(({ text }) => !said.has(text.trim()));

  return {
    pass: unproven.length === 0,
    offenders: unproven.map(({ text, at }) => ({
      kind: "number" as const,
      text,
      at,
      why: "no executable derivation cleared it",
    })),
    examined: examined.length,
    found: found.length,
    ...(verbatim.length === 0
      ? {}
      : {
          audited: verbatim.map((text) => ({
            text,
            program: "",
            result: "the tool data answers with this exact text",
            verdict: "cleared-by-verbatim" as const,
            attempts: 0,
          })),
        }),
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
 *  browser. A DISPLAY screen with nothing to press passes vacuously; an `action`
 *  case does not, because a case that asked the screen to do something is proven
 *  by a tool call — or by a confirmation, since the probe stops at the dialog
 *  and the call behind it can never reach this trace. */
export function wiredActions(
  trace: readonly Probed[],
  world: World,
  tags: readonly CaseTag[] = [],
): WiredActionsResult {
  const bindings = trace.flatMap((candidate): Binding[] => {
    if (candidate.calls.length === 0) {
      return [
        candidate.dialog !== undefined
          ? { where: candidate.label, effect: "state", why: "opened a confirmation — not followed; the judge reads it" }
          : candidate.changed
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
  const acted = bindings.some((binding) => binding.effect === "tool" && holds(binding))
    ? "tool"
    : trace.some((candidate) => candidate.dialog !== undefined)
      ? "confirmation"
      : undefined;
  const why =
    tags.includes("action") && acted === undefined
      ? "this case asks the screen to DO something, and no press ever asked the host for anything or opened a confirmation"
      : undefined;
  return {
    pass: why === undefined && bindings.every(holds),
    pressed: trace.length,
    bindings,
    ...(acted === undefined ? {} : { acted }),
    ...(why === undefined ? {} : { why }),
  };
}

// ---------------------------------------------------------------------- floor

/**
 * The five checks in report order, each under the name the report prints. One
 * list, so a score and a column can never disagree about what was checked. Four
 * of them are decided here and are entirely deterministic; `honestData` is the
 * one that also leans on a model, and only ever to WAIVE a token or to write a
 * program the harness itself runs (`audit.ts`, `triage.ts`).
 *
 * A pass is not always a pass. A check with nothing in front of it is VACUOUS —
 * a screen with no numbers on it, a screen with nothing to press — and a check
 * whose model could not be reached is DEGRADED. Neither was earned and neither
 * was missed, so both stay out of any total: summing bare booleans is how a
 * blank page came to score 5/5 in the only aggregate this benchmark has.
 */
export const checks = (
  floor: FloorResult,
): ReadonlyArray<{ name: string; pass: boolean; vacuous?: true; degraded?: true }> => [
  { name: "delivered", pass: floor.delivered },
  { name: "renders", pass: floor.renders },
  { name: "valid", pass: floor.valid },
  {
    name: "honestData",
    pass: floor.honestData.pass,
    ...(floor.honestData.degraded === true
      ? { degraded: true as const }
      : floor.honestData.pass && floor.honestData.examined === 0
        ? { vacuous: true as const }
        : {}),
  },
  {
    name: "wiredActions",
    pass: floor.wiredActions.pass,
    ...(floor.wiredActions.pass && floor.wiredActions.pressed === 0 ? { vacuous: true as const } : {}),
  },
];

/** Every check has to hold. Written once because `honestData` is re-decided once
 *  the auditor has run, and two spellings of the floor would eventually
 *  disagree.
 *
 *  A DEGRADED honesty check is the exception, and for the reason a degraded
 *  judge never fails the run: the triage and the auditor are third parties on
 *  someone else's infrastructure, and an outage in our own machinery is not the
 *  contender's failure. It is loud in `result.json` and in the preview instead. */
export const passes = (floor: Omit<FloorResult, "pass">): boolean =>
  floor.delivered &&
  floor.renders &&
  floor.valid &&
  (floor.honestData.pass || floor.honestData.degraded === true) &&
  floor.wiredActions.pass;

export function runFloor(input: {
  world: World;
  artifact: string | undefined;
  /** What the product's own checks floor blocks in the delivered artifact. */
  blocking: readonly string[];
  trace: readonly Probed[];
  shot: Shot | undefined;
  /** The case's own tags. `action` is the one that raises the bar. */
  tags?: readonly CaseTag[];
}): FloorResult {
  const delivered = input.artifact !== undefined && input.artifact.trim() !== "";
  const renders = input.shot?.renders === true;
  const valid = delivered && input.blocking.length === 0;
  // Extraction, and the one clearing that needs nobody: what the screen printed,
  // minus whatever the tools answer with in those exact characters. The rest is
  // for the triage to sort and the auditor to answer for.
  const data = honestData(input.shot?.visibleText ?? "", input.world);
  const actions = wiredActions(input.trace, input.world, input.tags ?? []);
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
