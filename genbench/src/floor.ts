import type { Json, UIPayload } from "@vendoai/core";
import type { Shot } from "./render.js";
import type { World } from "./world.js";

export interface Offender {
  readonly kind: "number" | "date";
  readonly text: string;
  readonly why: string;
}

export interface HonestDataResult {
  readonly pass: boolean;
  readonly offenders: readonly Offender[];
}

export interface Binding {
  readonly tool: string;
  readonly known: boolean;
  readonly argsValid: boolean;
  readonly where: string;
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
const numberKey = (value: number): string => String(Math.round(Math.abs(value) * 100) / 100);

/** The same amount authored in dollars may be shown in cents, and vice versa. */
const numberKeys = (value: number): string[] => [numberKey(value), numberKey(value / 100), numberKey(value * 100)];

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const HUMAN_DATE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
const NUMBER = /-?\$?\d[\d,]*(?:\.\d+)?/g;

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
 *  numeric field across one tool's rows. Anything else on screen is invented. */
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
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      for (const [field, value] of Object.entries(row as Record<string, unknown>)) {
        if (typeof value !== "number") continue;
        const seen = columns.get(field) ?? [];
        seen.push(value);
        columns.set(field, seen);
      }
    }
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
  // Dates are consumed first and blanked out, so "Aug 1" never leaves a stray
  // `1` for the number pass to flag.
  let remaining = visibleText;
  const takeDates = (pattern: RegExp, iso: boolean): void => {
    remaining = remaining.replace(pattern, (match, a: string, b: string, c: string | undefined) => {
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
    const value = Number(text.replace(/[$,]/g, ""));
    if (!Number.isFinite(value)) continue;
    if (index.numbers.has(numberKey(value))) continue;
    offenders.push({
      kind: "number",
      text,
      why: "not a value any tool returned, and not a sum, count, min, max or mean of one",
    });
  }
  return { pass: offenders.length === 0, offenders };
}

// -------------------------------------------------------------- wired actions

interface RawBinding {
  readonly tool: string;
  readonly args: unknown;
  readonly where: string;
}

/** Walk the compiled payload for everything that names a tool: the tree's
 *  queries, and every `{ action, payload }` prop on any node, at any depth. */
export function bindingsFromPayload(payload: UIPayload): readonly RawBinding[] {
  const found: RawBinding[] = [];
  const queries = (payload as { queries?: Array<{ name: string; tool: string; input?: Json }> }).queries ?? [];
  for (const query of queries) {
    found.push({ tool: query.tool, args: query.input ?? {}, where: `query ${query.name}` });
  }

  const collect = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item, where);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    // `fn:` names a host component's own function, never a tool, so it is not a
    // tool binding to grade. No host components are registered in this bench.
    if (typeof record.action === "string" && !record.action.startsWith("fn:")) {
      found.push({ tool: record.action, args: record.payload ?? {}, where });
    }
    for (const item of Object.values(record)) collect(item, where);
  };
  const nodes = (payload as { nodes?: Array<{ id: string; props?: unknown }> }).nodes ?? [];
  for (const node of nodes) collect(node.props, `node ${node.id}`);
  return found;
}

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

export function wiredActions(bindings: readonly RawBinding[], world: World): WiredActionsResult {
  const graded = bindings.map((binding): Binding => {
    const tool = world.tools.find((candidate) => candidate.name === binding.tool);
    if (tool === undefined) {
      return { ...binding, known: false, argsValid: false, why: `no tool named "${binding.tool}"` };
    }
    const why = checkArgs(binding.args, tool.descriptor.inputSchema as Record<string, unknown>);
    return { tool: binding.tool, where: binding.where, known: true, argsValid: why === undefined, ...(why === undefined ? {} : { why }) };
  });
  return { pass: graded.every((binding) => binding.known && binding.argsValid), bindings: graded };
}

// ---------------------------------------------------------------------- floor

export function runFloor(input: {
  world: World;
  artifact: string | undefined;
  /** What the product's own checks floor blocks in the delivered artifact. */
  blocking: readonly string[];
  payload: UIPayload | undefined;
  shot: Shot | undefined;
}): FloorResult {
  const delivered = input.artifact !== undefined && input.artifact.trim() !== "";
  const renders = input.shot?.renders === true;
  const valid = delivered && input.blocking.length === 0;
  const data = honestData(input.shot?.visibleText ?? "", buildIndex(input.world));
  const actions =
    input.payload === undefined
      ? { pass: false, bindings: [] }
      : wiredActions(bindingsFromPayload(input.payload), input.world);
  return {
    delivered,
    renders,
    valid,
    blocking: input.blocking,
    honestData: data,
    wiredActions: actions,
    pass: delivered && renders && valid && data.pass && actions.pass,
  };
}
