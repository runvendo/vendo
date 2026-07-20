/**
 * W1-bench (docs/verification/w1-bench) — metrics computed from the REAL
 * production compiler (compileWireV2 with the fixture tool shapes). The
 * reliability signals — compile-error rate, reference/binding errors,
 * declared-but-unused queries, unknown tools/components — are the compiler's
 * own verdicts, not a re-implementation.
 */
import {
  compileWireV2,
  PREWIRED_COMPONENT_NAMES,
  type Json,
  type ShapeType,
  type TreeNode,
} from "@vendoai/core";
import { CATALOG_COMPONENT_NAMES, KNOWN_TOOL_NAMES } from "./fixtures.js";

const CENTS = /(amountcents|balancecents|totalcents|revenuecents|cents)$/i;
const DATE = /^(duedate|date|month|createdat|paidat)$|date$/i;
const CHART_COMPONENTS = new Set(["LineChart", "BarChart", "Donut", "Sparkline"]);
const CHART_DATA_PROPS = new Set(["points", "series", "slices", "values", "data"]);

const collectPaths = (value: Json, out: string[]): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectPaths(v as Json, out);
    return;
  }
  const rec = value as Record<string, Json>;
  if (typeof rec.$path === "string") out.push(rec.$path);
  for (const v of Object.values(rec)) collectPaths(v, out);
};

const queryOfPath = (path: string): string | null => {
  const seg = path.split("/").filter(Boolean);
  return seg[0] ?? null;
};

const lastFieldOf = (path: string): string => {
  const seg = path.split("/").filter(Boolean);
  for (let i = seg.length - 1; i >= 1; i--) {
    if (!/^\d+$/.test(seg[i]!)) return seg[i]!;
  }
  return "";
};

export interface WireMetrics {
  compileOk: boolean;
  /** All wiring/reference errors: binding-shape + unknown tool/query/component + invalid action. */
  refErrors: number;
  bindingShapeErrors: number;
  unknownTool: number;
  unknownRef: number;
  unknownComponent: number;
  invalidAction: number;
  declaredButUnused: number;
  /** Cents/date value shown to a user without a format step. */
  formatMiss: number;
  /** Formatted value wrongly fed to a chart (draws NaN). */
  formatWrongOnChart: number;
  queryCount: number;
  nodeCount: number;
  islandCount: number;
  usedDisclaimer: boolean;
  empty: boolean;
}

const HARD_STRUCTURAL = new Set([
  "missing-app", "nested-app", "truncated-tag", "eof-unclosed", "unclosed-element",
  "unclosed-skipped", "compile-failed", "node-limit", "query-limit", "component-limit",
  "invalid-query-tool", "invalid-query-name", "unknown-element",
]);

export const computeWireMetrics = (
  wire: string,
  toolShapes: Readonly<Record<string, ShapeType>>,
  opts: { inlineRefs?: boolean } = {},
): WireMetrics => {
  const r = compileWireV2(wire, { toolShapes, hostComponents: [...CATALOG_COMPONENT_NAMES], inlineRefs: opts.inlineRefs });
  const nodes = r.tree.nodes ?? [];
  const queries = r.tree.queries ?? [];
  const islandNames = new Set(Object.keys(r.components ?? {}));
  const allowedComponents = new Set<string>([...PREWIRED_COMPONENT_NAMES, ...CATALOG_COMPONENT_NAMES, ...islandNames]);

  const issueCounts = new Map<string, number>();
  for (const iss of r.issues) issueCounts.set(iss.code, (issueCounts.get(iss.code) ?? 0) + 1);

  // Unknown tool names on queries.
  let unknownTool = 0;
  for (const q of queries) {
    const tool = q.tool.startsWith("fn:") ? q.tool.slice(3) : q.tool;
    if (!q.tool.startsWith("fn:") && !KNOWN_TOOL_NAMES.has(tool)) unknownTool++;
  }

  // Unknown components (non-island, non-prewired, non-catalog).
  let unknownComponent = 0;
  for (const n of nodes) {
    if (n.id === "root") continue;
    if (!allowedComponents.has(n.component)) unknownComponent++;
  }

  // Binding usage → declared-but-unused queries.
  const usedQueryNames = new Set<string>();
  const allPaths: string[] = [];
  for (const n of nodes) if (n.props) collectPaths(n.props as Json, allPaths);
  for (const p of allPaths) {
    const q = queryOfPath(p);
    if (q) usedQueryNames.add(q);
  }
  const declaredButUnused = queries.filter((q) => !usedQueryNames.has(q.name)).length;

  // Format checks on the compiled tree.
  let formatMiss = 0;
  let formatWrongOnChart = 0;
  for (const n of nodes) {
    if (!n.props) continue;
    const props = n.props as Record<string, Json>;
    if (CHART_COMPONENTS.has(n.component) || n.component === "Sparkline") {
      // A chart data prop bound with a format reshape draws NaN.
      for (const key of CHART_DATA_PROPS) {
        const v = props[key];
        if (v && typeof v === "object" && "$reshape" in (v as object)) formatWrongOnChart++;
      }
      continue;
    }
    if (n.component === "Stat") {
      const field = valueField(props.value);
      if (field && (CENTS.test(field) || DATE.test(field)) && props.format === undefined && !hasReshape(props.value)) formatMiss++;
    }
    if (n.component === "Text" || n.component === "Badge") {
      const field = valueField(props.value ?? props.text ?? props.label);
      if (field && (CENTS.test(field) || DATE.test(field)) && !hasReshape(props.value ?? props.text ?? props.label)) formatMiss++;
    }
    if (n.component === "DataTable" || n.component === "Table") {
      // Fair to both dialects: a $reshape pipe on rows (`rows={x | format(...)}`)
      // formats in place, so only count column misses when there is none.
      if (!hasReshape(props.rows)) formatMiss += tableColumnFormatMisses(props.columns);
    }
  }

  const invalidAction = issueCounts.get("invalid-action") ?? 0;
  const unknownRef = issueCounts.get("unknown-reference") ?? 0;
  const bindingShapeErrors = r.bindingErrors.length;

  const hasHard = [...issueCounts.keys()].some((c) => HARD_STRUCTURAL.has(c));
  const empty = nodes.length <= 1;
  const compileOk = r.complete && !hasHard && !empty;

  const usedDisclaimer = nodes.some((n) => n.component === "Disclaimer");

  return {
    compileOk,
    refErrors: bindingShapeErrors + unknownTool + unknownRef + unknownComponent + invalidAction,
    bindingShapeErrors,
    unknownTool,
    unknownRef,
    unknownComponent,
    invalidAction,
    declaredButUnused,
    formatMiss,
    formatWrongOnChart,
    queryCount: queries.length,
    nodeCount: nodes.length,
    islandCount: islandNames.size,
    usedDisclaimer,
    empty,
  };
};

const valueField = (v: Json | undefined): string => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "";
  const rec = v as Record<string, Json>;
  if (typeof rec.$path === "string") return lastFieldOf(rec.$path);
  return "";
};

const hasReshape = (v: Json | undefined): boolean => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return "$reshape" in (v as object);
};

const tableColumnFormatMisses = (columns: Json | undefined): number => {
  if (!Array.isArray(columns)) return 0;
  let misses = 0;
  for (const col of columns) {
    if (typeof col === "string") {
      const seg = col.split(".").pop() ?? col;
      if (CENTS.test(seg) || DATE.test(seg)) misses++;
    } else if (col && typeof col === "object") {
      const c = col as Record<string, Json>;
      const key = typeof c.key === "string" ? (c.key.split(".").pop() ?? c.key) : "";
      const hasFormat = c.format !== undefined;
      if (key && (CENTS.test(key) || DATE.test(key)) && !hasFormat) misses++;
    }
  }
  return misses;
};
