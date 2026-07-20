/**
 * W1-bench Experiment 2 — the builder-calls fork. The app is emitted as a
 * stream of strict tool calls in ONE assistant turn: `set_query`,
 * `begin_region`/`end_region` for nesting (order-based; the compiler still
 * mints ids), a `place_<Component>` tool per prewired/catalog component
 * (constrained component + prop names), and `define_island`. Bindings and
 * actions are structured tool inputs (`bind_data` field paths). The call
 * stream is reconstructed into ordinary wire so it goes through the exact same
 * compileWireV2 + metrics path as the JSX arm.
 */
import { jsonSchema, tool, type ToolSet } from "ai";
import { PREWIRED_SCHEMAS } from "../prewired-schema.js";
import { MAPLE_CATALOG } from "./fixtures.js";

const LAYOUT = new Set(["Stack", "Row", "Grid", "Card", "Surface"]);

const componentNames = [
  ...Object.keys(PREWIRED_SCHEMAS),
  ...MAPLE_CATALOG.map((c) => c.name),
];
const leafNames = componentNames.filter((n) => !LAYOUT.has(n));

const sig = (name: string): string => {
  const pre = PREWIRED_SCHEMAS[name as keyof typeof PREWIRED_SCHEMAS];
  if (pre) return pre.signature;
  return MAPLE_CATALOG.find((c) => c.name === name)?.signature ?? name;
};

const objSchema = (props: Record<string, unknown>, required: string[] = []) =>
  jsonSchema({ type: "object", properties: props, required, additionalProperties: false } as Record<string, unknown>);

const placeInput = objSchema({
  props: { type: "object", description: "Literal prop values (strings/numbers/booleans/arrays), e.g. {label:\"Total\", format:\"money\"} or columns for a table.", additionalProperties: true },
  bindings: { type: "object", description: "prop -> data reference string like \"invoicesList.data\" or \"invoicesList.totalCents\" (optionally with a | format(...) pipe). The referenced query must be declared via set_query.", additionalProperties: { type: "string" } },
  actions: { type: "object", description: "prop -> host tool name for on* actions, e.g. {onClick:\"invoices.sendReminders\"}.", additionalProperties: { type: "string" } },
  actionPayloads: { type: "object", description: "prop -> data reference string for the action payload, e.g. {onClick:\"invoicesList.data.0.id\"}.", additionalProperties: { type: "string" } },
});

/** Build the strict tool set. */
// No-op result so the tool-use loop advances (the builder doesn't need real
// results — it is composing a tree, not reading data).
const ack = async () => ({ ok: true });

export const buildForkTools = (): ToolSet => {
  const tools: ToolSet = {};
  tools.set_query = tool({
    description: "Declare a data query. Its result is addressable by <name> in bindings.",
    inputSchema: objSchema(
      { name: { type: "string" }, tool: { type: "string" }, input: { type: "object", additionalProperties: true } },
      ["name", "tool"],
    ),
    execute: ack,
  });
  tools.begin_region = tool({
    description: `Open a layout container and make it the current parent. component is one of: ${[...LAYOUT].join(", ")}.`,
    inputSchema: objSchema(
      { component: { type: "string", enum: [...LAYOUT] }, props: { type: "object", additionalProperties: true } },
      ["component"],
    ),
    execute: ack,
  });
  tools.end_region = tool({ description: "Close the current layout container.", inputSchema: objSchema({}), execute: ack });
  tools.finish = tool({ description: "Call this once the app is fully composed.", inputSchema: objSchema({}), execute: ack });
  tools.define_island = tool({
    description: "Define a custom React island component by name with full TSX source (last resort).",
    inputSchema: objSchema({ name: { type: "string" }, source: { type: "string" } }, ["name", "source"]),
    execute: ack,
  });
  // One place tool per leaf component (constrained component + its prop signature).
  for (const name of leafNames) {
    tools[`place_${name}`] = tool({
      description: `Add a ${name} to the current parent. ${sig(name)}`,
      inputSchema: placeInput,
      execute: ack,
    });
  }
  return tools;
};

const bindingExpr = (ref: string): string => `{${ref}}`;

const attrsFor = (input: Record<string, unknown>): string => {
  const parts: string[] = [];
  const props = (input.props ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string") parts.push(`${k}="${v.replace(/"/g, "&quot;")}"`);
    else parts.push(`${k}={${JSON.stringify(v)}}`);
  }
  const bindings = (input.bindings ?? {}) as Record<string, string>;
  for (const [k, ref] of Object.entries(bindings)) parts.push(`${k}=${bindingExpr(ref)}`);
  const actions = (input.actions ?? {}) as Record<string, string>;
  const payloads = (input.actionPayloads ?? {}) as Record<string, string>;
  for (const [k, t] of Object.entries(actions)) {
    if (payloads[k]) parts.push(`${k}={{action:"${t}",payload:{value:${payloads[k]}}}}`);
    else parts.push(`${k}="${t}"`);
  }
  return parts.length ? " " + parts.join(" ") : "";
};

/** Reconstruct wire markup from the ordered tool-call stream. */
export const reconstructWire = (calls: { toolName: string; input: Record<string, unknown> }[]): string => {
  const queries: string[] = [];
  const islands: string[] = [];
  const body: string[] = [];
  const regionStack: string[] = [];
  for (const call of calls) {
    const inp = call.input ?? {};
    if (call.toolName === "set_query") {
      const name = String(inp.name ?? "q");
      const t = String(inp.tool ?? "");
      const input = inp.input && Object.keys(inp.input as object).length ? ` input={${JSON.stringify(inp.input)}}` : "";
      queries.push(`<Query id="${name}" tool="${t}"${input}/>`);
    } else if (call.toolName === "begin_region") {
      const comp = String(inp.component ?? "Stack");
      regionStack.push(comp);
      body.push(`<${comp}${attrsFor({ props: inp.props })}>`);
    } else if (call.toolName === "end_region") {
      const comp = regionStack.pop() ?? "Stack";
      body.push(`</${comp}>`);
    } else if (call.toolName === "define_island") {
      const name = String(inp.name ?? "Island");
      islands.push(`<Island name="${name}">${String(inp.source ?? "")}</Island>`);
    } else if (call.toolName.startsWith("place_")) {
      const comp = call.toolName.slice("place_".length);
      body.push(`<${comp}${attrsFor(inp)}/>`);
    }
  }
  while (regionStack.length) body.push(`</${regionStack.pop()}>`);
  return `<App name="Generated">${queries.join("")}${body.join("")}${islands.join("")}</App>`;
};
