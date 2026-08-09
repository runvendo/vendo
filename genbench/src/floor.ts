import type { UsageTotals } from "./meter.js";
import type { Probed } from "./probe.js";
import type { Shot } from "./render.js";
import type { World } from "./world.js";

export interface Offender {
  readonly kind: "number" | "date";
  readonly text: string;
  readonly why: string;
}

/** One value tier 1 could not clear, and what the auditor's code did about it.
 *  The program and its executed result are kept because they ARE the finding:
 *  a cleared value is only as good as the derivation anyone can re-run. */
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
  /** How many numeric/date tokens the check actually evaluated — tier-1 clears
   *  and offenders alike, carried unchanged once tier 2 re-decides some of
   *  them. A screen with nothing extractable is 0, and 0 still passes: this
   *  field is what tells that apart from a screen the check actually cleared. */
  readonly examined: number;
  /** Tier 2's record, one entry per value it was asked about. Absent when the
   *  deterministic pass cleared the screen outright and no auditor was called. */
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
  /** Absent when the press fired nothing at all. */
  readonly tool?: string;
  readonly known: boolean;
  readonly argsValid: boolean;
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

/** Money and counts collapse onto one key so "$2,850.00", "2850" and the raw
 *  2850 are the same fact. Sign is a display choice the style rubric owns, so
 *  the index compares magnitudes. */
export const numberKey = (value: number): string => String(Math.round(Math.abs(value) * 100) / 100);

/** The same amount authored in dollars may be shown in cents, and vice versa. */
export const numberKeys = (value: number): string[] => [numberKey(value), numberKey(value / 100), numberKey(value * 100)];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const HUMAN_DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
export const NUMBER = /-?\$?\d[\d,]*(?:\.\d+)?/g;

/** One number as the screen wrote it — "$2,850.00", "-1288.40" — as a number. */
export const numberIn = (text: string): number => Number(text.replace(/[$,]/g, ""));

/** A date is indexed at both precisions, because "Aug 1" carries no year. */
const dateKeys = (year: string | undefined, month: string, day: string): string[] => {
  const monthDay = `${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return year === undefined ? [monthDay] : [monthDay, `${year}-${monthDay}`];
};

export interface DataIndex {
  readonly numbers: ReadonlySet<string>;
  readonly dates: ReadonlySet<string>;
}

/** "One tool's rows" — the array itself, or the single array a response
 *  envelope wraps it in, which is how real hosts return collections. */
function rowsOf(data: unknown): readonly unknown[] {
  if (Array.isArray(data)) return data;
  if (typeof data !== "object" || data === null) return [];
  const arrays = Object.values(data).filter((value): value is unknown[] => Array.isArray(value));
  return arrays.length === 1 ? arrays[0]! : [];
}

function walkNumbers(value: unknown, onNumber: (n: number) => void, onDate: (iso: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkNumbers(item, onNumber, onDate);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) walkNumbers(item, onNumber, onDate);
    return;
  }
  if (typeof value === "number") onNumber(value);
  if (typeof value === "string") {
    for (const [, year, month, day] of value.matchAll(ISO_DATE)) onDate(`${year!}-${month!}-${day!}`);
  }
}

/** Every literal number and date the case's tools return, plus the closed set of
 *  values a contender is allowed to compute: sum, count, min, max and mean of one
 *  numeric field across one tool's rows, and the size of one tool's rows filtered
 *  to one field equalling one value. Anything else on screen is invented. */
export function buildIndex(world: World): DataIndex {
  const numbers = new Set<string>();
  const dates = new Set<string>();
  const add = (n: number): void => {
    for (const key of numberKeys(n)) numbers.add(key);
  };

  for (const tool of world.tools) {
    walkNumbers(tool.data, add, (iso) => {
      const [year, month, day] = iso.split("-") as [string, string, string];
      for (const key of dateKeys(year, month, day)) dates.add(key);
    });

    const rows = rowsOf(tool.data);
    add(rows.length);
    const columns = new Map<string, number[]>();
    /** `field=value` -> how many rows carry it. "2 pending transfers" is a fact
     *  these rows hold, not a number a screen invented. */
    const matching = new Map<string, number>();
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
        // Equality on a scalar field only: "same object" is not a filter a
        // person writes, and deep equality would open the rule up.
        if (typeof value !== "object" || value === null) {
          const key = `${field}=${JSON.stringify(value)}`;
          matching.set(key, (matching.get(key) ?? 0) + 1);
        }
        if (typeof value !== "number") continue;
        const seen = columns.get(field) ?? [];
        seen.push(value);
        columns.set(field, seen);
      }
    }
    // A count is its own magnitude and nothing else — two transfers is never
    // $0.02 or 200 of anything — so it is added exactly, never rescaled the way
    // an authored money amount is.
    for (const count of matching.values()) numbers.add(numberKey(count));
    for (const values of columns.values()) {
      const sum = values.reduce((total, value) => total + value, 0);
      add(sum);
      add(sum / values.length);
      add(Math.min(...values));
      add(Math.max(...values));
    }
  }
  return { numbers, dates };
}

export function honestData(visibleText: string, index: DataIndex): HonestDataResult {
  const offenders: Offender[] = [];
  let examined = 0;
  // Dates are consumed first and blanked out, so "Aug 1" never leaves a stray
  // `1` for the number pass to flag.
  let remaining = visibleText;
  const takeDates = (pattern: RegExp, iso: boolean): void => {
    remaining = remaining.replace(pattern, (match, a: string, b: string, c: string | undefined) => {
      examined += 1;
      const keys = iso ? dateKeys(a, b, c!) : dateKeys(c, String(MONTHS.indexOf(a.slice(0, 3).toLowerCase()) + 1), b);
      if (!keys.some((key) => index.dates.has(key))) {
        offenders.push({ kind: "date", text: match, why: "no tool returned this date" });
      }
      return " ".repeat(match.length);
    });
  };
  takeDates(ISO_DATE, true);
  takeDates(HUMAN_DATE, false);

  for (const match of remaining.matchAll(NUMBER)) {
    const text = match[0];
    const value = numberIn(text);
    if (!Number.isFinite(value)) continue;
    examined += 1;
    if (index.numbers.has(numberKey(value))) continue;
    offenders.push({
      kind: "number",
      text,
      why: "not a value any tool returned, and not a sum, count, min, max, mean or filtered count of one",
    });
  }
  return { pass: offenders.length === 0, offenders, examined };
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

/** What the probe actually saw fire, graded against the world. A control that was
 *  pressed and asked for nothing is the failure this replaced a static scan to
 *  catch: a screen can name a tool in its document and still be dead in a
 *  browser. A screen with nothing to press passes vacuously. */
export function wiredActions(trace: readonly Probed[], world: World): WiredActionsResult {
  const bindings = trace.flatMap((candidate): Binding[] => {
    if (candidate.calls.length === 0) {
      return [{ where: candidate.label, known: false, argsValid: false, why: "pressing it called nothing" }];
    }
    return candidate.calls.map((call): Binding => {
      const tool = world.tools.find((known) => known.name === call.name);
      if (tool === undefined) {
        return { where: candidate.label, tool: call.name, known: false, argsValid: false, why: `no tool named "${call.name}"` };
      }
      const why = checkArgs(call.args, tool.descriptor.inputSchema as Record<string, unknown>);
      return {
        where: candidate.label,
        tool: call.name,
        known: true,
        argsValid: why === undefined,
        ...(why === undefined ? {} : { why }),
      };
    });
  });
  return { pass: bindings.every((binding) => binding.known && binding.argsValid), bindings };
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

/** Every check has to hold. Written once because tier 2 re-decides it after the
 *  auditor has run, and two spellings of the floor would eventually disagree. */
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
  const data = honestData(input.shot?.visibleText ?? "", buildIndex(input.world));
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
