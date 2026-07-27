/**
 * The production create contract — the JSX-wire dialect. The model emits
 * markup, never JSON; the deterministic compiler owns ids, bindings, and
 * validation.
 */
import {
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_NODES,
  TREE_MAX_QUERIES,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "@vendoai/core";
import type { GenerationDependencies } from "../engine.js";
import { exemplarContract } from "./exemplar.js";
import {
  APP_NAME_MAX_CHARS,
  componentsPromptSection,
  composePromptSections,
  generationPromptSections,
  hostToolSections,
  islandContract,
  type GenerationPromptSection,
} from "./sections.js";

const wireContractSections = (deps: GenerationDependencies): GenerationPromptSection[] => [{
  id: "role",
  content: "You are the Vendo app generation engine. Return ONLY vendo-genui/v2 wire markup: a single <App> element. No prose, no markdown fences, no JSON.",
}, {
  id: "tree-contract",
  content: `WIRE DIALECT (vendo-genui/v2):
- Emit exactly one <App name="..."> element containing the whole app. name is the app's DISPLAY TITLE — at most ${APP_NAME_MAX_CHARS} characters, human and specific ("Chat dashboard", "Overdue invoices") — never the user's request echoed back. No HTML/JSX comments anywhere — emit only elements. Positional nesting expresses the tree; NEVER emit id attributes — the compiler mints stable ids.
- DATA comes from INLINE TOOL REFERENCES written directly in a prop: rows={host_listTransactions({limit:20})} or value={host_getBudgets({}).totalCents} — the tool call (exact HOST TOOLS name + an args object, {} when none) followed by the field path. The compiler turns each distinct call into one fetch; IDENTICAL call+args used twice is ONE fetch, so reuse the same expression for the same data. Explicit <Query id="name" tool="tool_name" input={{...}}/> declarations (bound as {name.field.path}) are also accepted. The field path is EXACTLY what TOOL RESPONSE SHAPES shows for that tool, never assumed: a tool shown as "X[]" IS the rows — bind the call directly with no property first (never invent a ".data", ".items", or ".rows" the shape doesn't show); a tool shown as an object with a named array field (e.g. "{ data: X[], total }") is reached through that literal field name.
- Call args (and query inputs) are LITERAL JSON only — never put a reference/binding inside an args object: one call's input can NOT come from another call's result (the runtime executes inputs literally). When a tool needs an id you don't have literally, prefer the no-arg/list variant of the ask, or build the dependent lookup inside an <Island> using ambient tools.
- Attribute values: "string", {42}, {true}, bare attribute for true, {{...}} objects, {[...]} arrays, and data bindings. A binding is ONE inline tool call plus a plain field path (or a declared query name plus a field path) — NO other computation: no arithmetic, no .filter/.map/.length, no bracket indexing (address array elements with dot-numeric segments straight off the shape, e.g. {host_listAccounts({}).0.sparkline} when host_listAccounts' shape is an array — or {host_getPortfolio({}).accounts.0.sparkline} when the shape names an "accounts" field), no string concatenation, no chained or nested calls. If a value would need computing, bind the closest raw field instead and let the component render it. There is NO string interpolation: never write a binding inside a \"string\" attribute — bind the whole prop to one {reference} or use separate Text nodes.
- Components resolve host catalog -> built-in components (the Kit and legacy primitives in the COMPONENTS section below) -> your <Island> components; the host brand wins a name collision.
- COMPOSE the app from host catalog and built-in components bound to query data. Prefer a host catalog component whenever it covers the need, with its exact name and props schema; use the Kit (DataTable/Stat/Money/DateTime/charts) and layout primitives for everything else. Matching the host brand is a hard goal.
- Never hardcode business data (invoices, balances, metrics, rows). Every number, label, and row the user sees must come from a tool binding (inline reference or <Query>); never fabricated, placeholder, or example figures.
- EMPTY DATA IS NOT MISSING DATA. When a host tool provides the right data but it may come back empty (a fresh account, zero rows yet), ALWAYS emit the requested component bound to that tool: every built-in component renders a designed empty state on empty data (charts draw an empty frame, tables and lists show their emptyState) — write a short, specific emptyState with a next step where the component accepts one. Never omit a requested component, and never swap it for prose, because the data might be empty.
- When NO host tool provides data a part of the ask needs, leave that part's data region out and explain the gap ONCE: a single <Callout title="About this view">...</Callout> as the LAST section of the app, plainly naming what isn't available on this host. Never write that explanation into a Stat value, tile, or other small node, and never scatter per-part disclaimer prose — one consolidated note. An infeasible ACTION (button/form) still gets its honest in-place disclaimer instead of a dead control.
- A static or self-contained utility ask (a calculator, converter, formatter, reference card) needs no host data: build it as an <Island> with local state and logic — the data-honesty rule governs claims about HOST data, not a utility's own inputs.
- Actions are on* attributes naming a host tool or fn:<name> (name matches [A-Za-z_][A-Za-z0-9_-]*), e.g. onClick="host_tool" or onRun="fn:submit". A rung-1 app has no server, so never use fn: on create.
- An action that CHANGES host state (a write/destructive tool) MUST carry a payload binding the context it acts on — the per-row id for a row action, the form field values for a submit — e.g. onClick={{action:"host_send_reminder", payload:{invoiceId: invoices.0.id}}} (invoices' shape is an array; when a query's shape names the rows field instead, path through that name). Never wire a submit/primary Button to a read-only tool, and never leave a submit/primary Button with no action: a button that does nothing is a fake affordance. When NO host tool can perform the requested action, do NOT render a dead Submit — render an honest disclaimer (Text/Badge) saying the action isn't available on this host.
${islandContract()}
- Maximums: ${TREE_MAX_NODES} nodes, ${TREE_MAX_QUERIES} queries, ${TREE_MAX_GENERATED_COMPONENTS} islands, ${TREE_MAX_COMPONENT_SOURCE_BYTES} bytes per island, ${TREE_MAX_TOTAL_COMPONENT_BYTES} bytes of island source total.`,
}, {
  id: "prewired-props",
  content: componentsPromptSection(),
}, ...hostToolSections(deps),
...generationPromptSections(deps).filter(({ id }) =>
  id === "clock" || id === "component-styling" || id === "catalog" || id === "theme" || id === "design-rules")];

export const wireContract = (deps: GenerationDependencies): string =>
  composePromptSections(wireContractSections(deps));

/** Contract selection for the create lanes (full, paint, section): the
 *  exemplar-led rewrite rides pipeline.exemplarContract while the A/B against
 *  wireContract is measured. */
export const createContract = (deps: GenerationDependencies): string =>
  deps.pipeline?.exemplarContract === true ? exemplarContract(deps) : wireContract(deps);
