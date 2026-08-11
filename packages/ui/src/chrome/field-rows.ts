/** spec §16 law 1 — the card body is NOT chosen by its data.
 *
 *  The consent cards used to pick between three mutually exclusive bodies (a
 *  consequence sentence, a `<dl>` of 1–8 primitive args, or a raw `<pre>` of the
 *  server's `inputPreview`), so the same ask looked like a different product
 *  depending on what the model happened to pass. One body now: field rows,
 *  always. Nested values flatten to compact `Key: value` lines (the shell's dd
 *  is `white-space: pre-line`), non-object args become one row, and a long arg
 *  list is simply a long list — never a fallback to raw JSON.
 */
import type { Json, JsonSchema } from "@vendoai/core";
import { argProperties, argValue, humanizeToolName, type ToolMeta } from "./humanize.js";
import { truncateHead } from "./truncate.js";

export interface CardFieldRow {
  /** WHICH argument this row is — the top-level input key, verbatim ("Input"
      for a non-object arg). Identity, never display: `humanizeToolName` is
      many-to-one (`recipient_name`, `recipientName` and `RecipientName` all
      read "Recipient name"), so anything matching a row against something else
      — the consent question's `questionKeys`, say — matches on this. */
  key: string;
  /** Humanized argument name ("recipient_name" → "Recipient name"). */
  label: string;
  /** What the person reads — host formatter first, else the shared money-safe
      value rule (`argValue`). */
  value: string;
  /** The raw value, for the dd tooltip: the consent honesty contract keeps the
      real input one hover away whenever display changed it. */
  raw: string;
  /** Numbers right-align on tabular figures so a column of amounts reads as a
      column (`.fl-card-field dd[data-numeric]`). */
  numeric: boolean;
}

/** A single field never renders more than this: one base64 blob or dumped row
    set otherwise lands thousands of characters inside the card (ENG-218). */
const VALUE_CAP = 400;

const bound = (text: string): string =>
  text.length > VALUE_CAP ? `${truncateHead(text, VALUE_CAP)}…` : text;

/** The LITERAL, for `CardFieldRow.raw` only — the honesty contract keeps the
    developer's real input one hover away, so `true` stays `true` here even
    though the card reads it as "Yes". Everything a person reads goes through
    `display` below, at every depth. */
function leaf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** The declared schema for one member of a container: an object's property, an
    array's `items`. Undefined where the host declared nothing there — the same
    "undeclared" state the top level already answers for honestly.

    Exported for H-7: the consequence sentence has to count money with the SAME
    descent these rows format it with, or the two disagree about what is on the
    card. */
export function memberSchema(schema: JsonSchema | undefined, key: string): JsonSchema | undefined {
  const properties = argProperties(schema);
  if (properties !== undefined) return properties[key];
  const items = schema?.items;
  return typeof items === "object" && items !== null ? items as JsonSchema : undefined;
}

/** One value, at any depth: a primitive goes through the SAME money/format seam
    the top-level rows use (`argValue` — which is also where `true` becomes
    "Yes"), a container becomes compact `Key: value` lines whose members go
    through it too.

    Nested values used to flatten with a raw `leaf()`, so a declared-cents amount
    inside an object printed as `Amount cents: 1850`, one level down (Maple's
    `host_createOrder` card). Formatting has to travel with the value, not stop
    at the first indentation. */
function display(key: string, value: unknown, schema: JsonSchema | undefined, meta?: ToolMeta): string {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      // An array's members share their parent's name and its `items` schema.
      return value.map(item => display(key, item, memberSchema(schema, key), meta)).join("\n");
    }
    return Object.entries(value)
      .map(([child, item]) =>
        `${humanizeToolName(child)}: ${display(child, item, memberSchema(schema, child), meta)}`)
      .join("\n");
  }
  // `argValue` reads the field's own declaration out of a properties map, and
  // this node holds only its own schema.
  return meta?.formatField?.(key, value as Json)
    ?? argValue(key, value, schema === undefined ? undefined : { [key]: schema });
}

/** The one body, for any args a tool call can carry. */
export function fieldRows(args: unknown, inputSchema?: JsonSchema, meta?: ToolMeta): CardFieldRow[] {
  const row = (key: string, label: string, value: string, raw: string, numeric: boolean): CardFieldRow =>
    ({ key, label, value: bound(value), raw: bound(raw), numeric });
  if (args === undefined || args === null) return [];
  if (typeof args !== "object") {
    return [row("Input", "Input", display("Input", args, inputSchema, meta), leaf(args), typeof args === "number")];
  }
  if (Array.isArray(args)) return [row("Input", "Input", display("Input", args, inputSchema, meta), leaf(args), false)];
  const properties = argProperties(inputSchema);
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => row(
    key,
    humanizeToolName(key),
    display(key, value, properties?.[key], meta),
    leaf(value),
    typeof value === "number",
  ));
}
