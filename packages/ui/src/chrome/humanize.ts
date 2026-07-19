/** ENG-216 — tool & approval humanization helpers.

    The approval/tool wire parts (01-core stream-parts) deliberately carry only
    `toolCallId` + `risk` + `approvalId`; no friendly name, description or arg
    formatting ever reaches the client. Chrome therefore humanizes at the render
    site: a host-supplied `ToolMeta` (VendoProvider `tools` prop) wins, and when
    it is absent these pure fallbacks prettify the raw id and args so end users
    never read a raw slug, a lifecycle string, or raw JSON. */
import type { Json } from "@vendoai/core";

/** Optional host-supplied friendly metadata for one tool (08-ui provider seam).
    Purely UI-side and additive — the host describes its own tools so chips and
    approvals read in human language; every field is optional and degrades to the
    formatting fallback below. */
export interface ToolMeta {
  /** Short display label, e.g. "Send email". */
  label?: string;
  /** One-line description shown under the approval title. */
  description?: string;
  /** Custom one-line argument summary for the tool chip. */
  summarize?(args: Json): string | undefined;
}

export type ToolMetaMap = Record<string, ToolMeta>;

/** Prettify a raw tool id / slug into a human label:
    `host_email_send` → "Email send", `fn:listInvoices` → "List invoices",
    `gmail_GMAIL_CREATE_EMAIL_DRAFT` → "Gmail create email draft". */
export function humanizeToolName(raw: string): string {
  const stripped = raw.replace(/^fn:/i, "").replace(/^host[_:.\- ]?/i, "");
  const words = stripped
    // camelCase / PascalCase boundaries
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // any run of separators
    .replace(/[._:\-\s]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map(word => word.toLowerCase());
  // Collapse consecutive duplicate tokens ("gmail GMAIL …" → "gmail …").
  const deduped = words.filter((word, index) => word !== words[index - 1]);
  if (deduped.length === 0) return raw;
  const sentence = deduped.join(" ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** The display title for a tool: host label wins, else the prettified id. */
export function toolTitle(name: string, meta?: ToolMeta): string {
  const label = meta?.label?.trim();
  return label ? label : humanizeToolName(name);
}

/** Proper-case display name for a toolkit slug ("slack" → "Slack",
    "google_calendar" → "Google Calendar"). The brand-forward connect surfaces
    (lane pick 2-A) never show the raw slug. */
export function toolkitDisplayName(toolkit: string): string {
  return toolkit
    .split(/[-_\s]+/)
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || toolkit;
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? `${json.slice(0, 79)}…` : json;
  } catch {
    return String(value);
  }
}

/** A plain-object argument map → humanized `{ label, value }` rows, in order.
    Non-object args (string / array / null) produce no rows — the caller keeps
    the server-formatted `inputPreview` string in that case. */
export function argFields(args: unknown): { label: string; value: string }[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    label: humanizeToolName(key),
    value: formatValue(value),
  }));
}

const SUMMARY_MAX = 120;

/** A compact one-line arg summary for a tool chip — never raw JSON. */
export function summarizeArgs(args: unknown): string | undefined {
  const fields = argFields(args);
  if (fields.length === 0) return undefined;
  const summary = fields.slice(0, 3).map(field => `${field.label} ${field.value}`).join(" · ");
  if (summary.length === 0) return undefined;
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary;
}

/** Multi-line `Label: value` preview for the approval card, replacing raw JSON.
    Falls back to a plain string / prettified JSON for non-object args. */
export function previewArgs(args: unknown): string {
  const fields = argFields(args);
  if (fields.length > 0) return fields.map(field => `${field.label}: ${field.value}`).join("\n");
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
