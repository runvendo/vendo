import { VENDO_TREE_FORMAT } from "@vendoai/core";
import type { Tree } from "@vendoai/core";
import { encodeCjtString } from "./profile-cjt.js";
import { encodeVtl } from "./profile-vtl.js";

/**
 * Prompt material for the live latency/validity trials (generate-latency.ts) and
 * fixture generation (generate-fixtures.ts). The compact-format few-shots are
 * built by running the real encoders on {@link EXAMPLE_TREE}, so an example the
 * model is shown is guaranteed to decode cleanly with the same code the trials
 * validate against — no hand-transcribed drift. Final prompt wording is captured
 * in DESIGN.md.
 */

export type Arm = "readable" | "cjt" | "vtl";

/** A small but realistic worked example: a two-stat invoices summary card. */
export const EXAMPLE_TREE: Tree = {
  formatVersion: VENDO_TREE_FORMAT,
  root: "root",
  nodes: [
    { id: "root", component: "Stack", source: "prewired", props: { gap: "md", padding: "lg" }, children: ["title", "row"] },
    { id: "title", component: "Text", source: "prewired", props: { text: "Invoices", variant: "heading" } },
    { id: "row", component: "Row", source: "prewired", props: { gap: "lg" }, children: ["open", "overdue"] },
    { id: "open", component: "Surface", source: "prewired", children: ["openLabel", "openValue"] },
    { id: "openLabel", component: "Text", source: "prewired", props: { text: "Open", variant: "label" } },
    { id: "openValue", component: "Text", source: "prewired", props: { text: { $path: "/summary/open" }, variant: "value" } },
    { id: "overdue", component: "Surface", source: "prewired", children: ["odLabel", "odValue"] },
    { id: "odLabel", component: "Text", source: "prewired", props: { text: "Overdue", variant: "label" } },
    { id: "odValue", component: "Text", source: "prewired", props: { text: { $path: "/summary/overdue" }, variant: "value" } },
  ],
  data: { summary: { open: "$12,400", overdue: "$3,100" } },
  queries: [{ path: "/summary", tool: "host_invoices_summary" }],
};

const READABLE_SPEC = `You output a "vendo-genui/v1" UI tree as JSON. Shape:
{
  "formatVersion": "vendo-genui/v1",
  "root": "<id of the root node>",
  "nodes": [ { "id", "component", "source"?, "props"?, "children"? }, ... ],   // FLAT array; edges are child-id references, not nesting
  "data"?: { ... },              // shared data model
  "queries"?: [ { "path", "tool", "input"? } ],   // path is a JSON Pointer ("" = whole model)
  "components"?: { "PascalName": "<esm source>" }  // only for source:"generated" nodes
}
- source is one of "prewired" | "host" | "generated" (omit if unknown).
- Prewired primitives: Stack, Row, Grid, Text, Skeleton, Surface, Divider.
- A prop value may be a literal, a binding { "$path": "/json/pointer" } or { "$state": "name" }, or an action { "action": "<tool-or-fn>", "payload"?: {} }.
- Pass props as a JSON object, never a stringified string.`;

const CJT_SPEC = `You output a compact JSON tree ("vendo-cjt/1"). Same information as the readable "vendo-genui/v1" tree, encoded densely:
{
  "f": "vendo-cjt/1",
  "r": "<root id>",
  "k": ["<component name>", ...],        // intern table: components are referenced by their index in this array
  "n": [ [id, compIdx, srcCode, props, children], ... ],   // one tuple per node; trailing absent fields are dropped
  "d"?: { ... },                          // data model
  "q"?: [ [path, tool] | [path, tool, input] ],
  "c"?: { "PascalName": "<esm source>" }
}
- compIdx is the 0-based index of the node's component in "k".
- srcCode: 0=absent, 1=prewired, 2=host, 3=generated.
- props is a JSON object (or omitted); children is an array of child-id strings (or omitted). Drop them from the tuple end when absent, but keep at least [id, compIdx].
- Bindings/actions inside props are unchanged ({ "$path": ... } etc.).`;

const VTL_SPEC = `You output a compact line format ("VTL"). One line per thing; lines joined by newlines. The first character of each line is an opcode.
Line 1:            vtl1 <rootId>
Node line:         -<id> <sig><component>[TAB<propsJSON>[TAB<child ids space-separated>]]
Data line:         D<TAB><minified JSON of the data model>
Query line:        Q<TAB><JSON array: [path, tool] or [path, tool, input]>
Component line:    C<TAB><JSON array: [name, esmSource]>
where TAB is a literal tab character, and <sig> encodes source: "." prewired, ":" host, "*" generated, or nothing if source is unset.
- props is minified JSON (object). Omit the first TAB+segment entirely if the node has no props and no children.
- If a node has children, ALWAYS write two TAB-separated segments after the head: the props segment (may be empty for no props) then the space-separated child ids.
- ids and component names must contain no spaces or tabs.
- Bindings/actions inside props are unchanged ({ "$path": ... } etc.).`;

function readableExample(): string {
  return JSON.stringify(EXAMPLE_TREE);
}

export function specFor(arm: Arm): string {
  if (arm === "readable") return READABLE_SPEC;
  if (arm === "cjt") return CJT_SPEC;
  return VTL_SPEC;
}

export function fewShotFor(arm: Arm): { request: string; output: string } {
  const request = "Show a summary card with two stats: Open and Overdue invoice totals, bound to /summary.";
  if (arm === "readable") return { request, output: readableExample() };
  if (arm === "cjt") return { request, output: encodeCjtString(EXAMPLE_TREE) };
  return { request, output: encodeVtl(EXAMPLE_TREE) };
}

export function systemPromptFor(arm: Arm): string {
  const { request, output } = fewShotFor(arm);
  return [
    "You are Vendo, a generative-UI engine embedded in a business app. When asked for a view, you emit ONE UI payload and nothing else.",
    "",
    specFor(arm),
    "",
    "Rules:",
    "- Output ONLY the payload. No prose, no explanation, no Markdown code fences.",
    "- Use prewired primitives (Stack, Row, Grid, Text, Surface, Divider) for layout; a Surface with a label Text and a value Text is the stat-card idiom.",
    "- Bind numbers/labels to the data model with { \"$path\": \"/pointer\" } rather than inlining, and declare the data model.",
    "- Keep it to a focused, well-structured view (roughly 8-40 nodes).",
    "",
    "Worked example —",
    `Request: ${request}`,
    "Output:",
    output,
  ].join("\n");
}

/** Realistic host-app UI requests, Cadence/accounting-flavored. */
export const UI_REQUESTS: { id: string; prompt: string }[] = [
  {
    id: "at-risk-clients",
    prompt:
      "Show a dashboard of the clients furthest behind on their tax documents: a heading, then a table with columns Client, Documents Missing, Days Overdue, and a status badge per row. Include 6 rows bound to /clients and a summary stat row above the table.",
  },
  {
    id: "deadline-timeline",
    prompt:
      "Build a filing-deadline view: a title, three KPI stat cards (Due This Week, Due This Month, Overdue) bound to /summary, and below them a list of the next 8 deadlines from /deadlines, each showing the client name, form type, and due date.",
  },
  {
    id: "document-progress",
    prompt:
      "Create a document-collection progress view for one client: their name and firm as a header, then a grid of document cards from /documents where each card shows the document name, a status label, and a received date; group visually by status.",
  },
];
