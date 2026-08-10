/**
 * The two DESIGN failures that are decidable by looking things up, so they cost
 * no model call: a screen with no lead, and a list too long to read.
 *
 * They are facts, not taste. "How many nodes did the writer mark as a heading"
 * and "how many rows did the query really return" are both counts, and both
 * decide a screen that is unreadable however well it is styled — three co-equal
 * headings leave nothing leading, and a table bound to every row of a long
 * result is one endless column on a phone-width screen.
 *
 * It runs at the `validate` door only, never on the paint seam: the seam
 * refuses to paint on a `block` (`render-seam.ts`), so a design block there
 * would blank the screen instead of improving it. At the door a block is one
 * repair round, which is exactly what it is worth.
 */
import { isPathBinding } from "@vendoai/core";
import type { Tree } from "../../contract/index.js";
import { isRecord, treeOf } from "./facts.js";
import type { Check, Finding } from "./types.js";

/** Rows past which a bound list needs a pager. Well above any dashboard's
 *  "recent N" (25 is the common one) and well below what a phone can show. */
const LONG_LIST_ROWS = 40;

const atProp = (nodeId: string, prop: string, message: string): Finding =>
  ({ severity: "block", where: `node "${nodeId}" prop "${prop}"`, message });

/** The array a `$path` really resolves to in the app's own query results, or
 *  undefined when the path does not reach one. */
const boundRows = (samples: Readonly<Record<string, unknown>>, path: string): unknown[] | undefined => {
  const [, queryName = "", ...rest] = path.split("/");
  let cursor: unknown = samples[queryName];
  for (const key of rest) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return Array.isArray(cursor) ? cursor : undefined;
};

/** Two or more headings and nothing leads. ZERO is deliberately fine: a `Card`
 *  title or a leading `Stat` can carry the lead. */
const headlineFindings = (tree: Tree): Finding[] => {
  const headings = tree.nodes.filter((node) => node.component === "Text" && node.props?.variant === "heading");
  if (headings.length < 2) return [];
  return [{
    severity: "block",
    where: "document",
    message: `this screen writes ${headings.length} nodes as <Text variant="heading">, so nothing leads: keep ONE heading, at the top, naming the screen, and demote the section titles to the surrounding <Card title="…"> or <Text variant="label">.`,
  }];
};

const longListFindings = (tree: Tree, samples: Readonly<Record<string, unknown>>): Finding[] => {
  const findings: Finding[] = [];
  for (const node of tree.nodes) {
    if (node.props === undefined) continue;
    if (node.props.paginate !== undefined || node.props.limit !== undefined) continue;
    for (const prop of ["rows", "data"]) {
      const value = node.props[prop];
      if (!isPathBinding(value)) continue;
      const rows = boundRows(samples, value.$path);
      if (rows === undefined || rows.length < LONG_LIST_ROWS) continue;
      findings.push(atProp(node.id, prop, `binds ${value.$path}, which really returns ${rows.length} rows — a ${rows.length}-row list is one column far taller than a phone screen, which no one can read and no screenshot can capture. Set paginate={25} (the rows stay bound; the pager reaches them).`));
    }
  }
  return findings;
};

/**
 * The design facts, measured against the app's OWN query results (`samples`,
 * the same evidence the reviewer reads) — so the row count is the real one and
 * not a sentence in a prompt.
 */
export const designCheck = (samples?: Readonly<Record<string, unknown>>): Check => ({
  name: "design-facts",
  kind: "fact",
  run: async ({ document }) => {
    const tree = treeOf(document);
    if (tree === undefined) return [];
    return [...headlineFindings(tree), ...(samples === undefined ? [] : longListFindings(tree, samples))];
  },
});
