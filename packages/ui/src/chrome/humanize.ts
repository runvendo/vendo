/** ENG-216 — tool & approval humanization helpers.

    The approval/tool wire parts (01-core stream-parts) deliberately carry only
    `toolCallId` + `risk` + `approvalId`; no friendly name, description or arg
    formatting ever reaches the client. Chrome therefore humanizes at the render
    site: a host-supplied `ToolMeta` (VendoProvider `tools` prop) wins, and when
    it is absent these pure fallbacks prettify the raw id and args so end users
    never read a raw slug, a lifecycle string, or raw JSON. */
import { declaredMoneyUnit, VENDO_TOOL_TITLES, type Json, type JsonSchema } from "@vendoai/core";
import { currencyMinorUnits, formatMoney, getKitIntl } from "../kit/format.js";

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
  /** Display formatting for one approval-card field value (e.g. integer cents
      → "$500.00"). Return undefined to keep the raw value. Display-only: the
      raw args still drive the decision hash and the exact-input grant. */
  formatField?(key: string, value: Json): string | undefined;
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

/**
 * The display title for a tool, most local authority first: the host's
 * in-code `ToolMeta.label`, then the descriptor's authored `title` (written by
 * sync's enrichment into `.vendo/tools.json`, correctable in
 * `.vendo/overrides.json` — the same label the MCP door puts on the wire), then
 * Vendo's own title for its own tools, then the prettified id.
 *
 * That third step exists because most surfaces have NO descriptor: the wire tool
 * part carries only a name, so a progress chip or an activity row prettified
 * `vendo_apps_open` into "Vendo apps open" — our namespace read out as words, the
 * §3 leak. The table is core's, the same one the descriptors author from, so
 * the two can never disagree.
 */
export function toolTitle(name: string, meta?: ToolMeta, descriptorTitle?: string): string {
  const label = meta?.label?.trim();
  if (label) return label;
  const authored = descriptorTitle?.trim();
  if (authored) return authored;
  return VENDO_TOOL_TITLES[name] ?? humanizeToolName(name);
}

/** Well-known toolkit slugs whose display name is not just proper-casing
    ("googlecalendar" → "Google Calendar"). One table for every chrome surface
    (connect card/dock/tray, connected accounts) so names can't drift. */
const TOOLKIT_DISPLAY: Record<string, string> = {
  slack: "Slack",
  github: "GitHub",
  gmail: "Gmail",
  notion: "Notion",
  linear: "Linear",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googlesheets: "Google Sheets",
  hubspot: "HubSpot",
  clickup: "ClickUp",
};

/** Display name for a toolkit slug: the known-brand table first (separator-less
    slugs like "googlecalendar" can't be recovered by splitting), then a
    separator-splitting proper-caser ("google_calendar" → "Google Calendar").
    The brand-forward connect surfaces never show the raw slug. */
export function toolkitDisplayName(toolkit: string): string {
  const known = TOOLKIT_DISPLAY[toolkit.toLowerCase().replace(/[-_\s]+/g, "")];
  if (known) return known;
  return toolkit
    .split(/[-_\s]+/)
    .filter(word => word.length > 0)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ") || toolkit;
}

/** What connecting a toolkit actually lets us do, in the words a person uses
    for it. Never an OAuth scope string: `https://www.googleapis.com/auth/gmail.send`
    is the grant's identifier, not its meaning, and a consent surface that shows
    the identifier has told the reader nothing (§16 law 3, the same law the
    connect refusal copy answers). */
const TOOLKIT_ACCESS: Record<string, string> = {
  gmail: "read and send mail as you",
  googlemail: "read and send mail as you",
  slack: "read and post messages as you",
  github: "read your repositories and open issues and pull requests as you",
  notion: "read and edit your pages as you",
  linear: "read and update your issues as you",
  googlecalendar: "read your calendar and create events as you",
  googledrive: "read and add files in your Drive as you",
  googlesheets: "read and edit your spreadsheets as you",
  hubspot: "read and update your contacts and deals as you",
  clickup: "read and update your tasks as you",
};

/** The access line for a toolkit — a verb phrase the card wraps ("Connecting
    lets us …"). The generic fallback names the service and stops there: a guess
    at a specific permission would be worse than the honest general one. */
export function toolkitAccessCopy(toolkit: string): string {
  const known = TOOLKIT_ACCESS[toolkit.toLowerCase().replace(/[-_\s]+/g, "")];
  return known ?? `act in ${toolkitDisplayName(toolkit)} as you`;
}

/** A tool's declared input properties, when the caller holds the descriptor. */
export type ArgProperties = Record<string, JsonSchema> | undefined;

/** Read `inputSchema.properties` off a descriptor, or undefined when the surface
    has no schema to consult (the in-thread card synthesizes an empty one). */
export function argProperties(inputSchema: JsonSchema | undefined): ArgProperties {
  const declared = inputSchema?.properties;
  return typeof declared === "object" && declared !== null ? declared as Record<string, JsonSchema> : undefined;
}

/** A boolean field answers a question ("Permanent?"), so it reads as an answer.
    `true` in front of a bank customer is the developer's literal, not the
    person's word; the raw literal stays on `CardFieldRow.raw` for dev mode.
    The KEY carries the meaning — this never invents a sentence around it. */
export const yesNo = (value: boolean): string => (value ? "Yes" : "No");

/**
 * One argument value, as a person must read it — the consent surfaces' rule.
 *
 * Money is the only value whose raw form reads as a DIFFERENT number: a $47.50
 * payment arrives as `4750` and reads as $4,750, on the one surface that gates
 * irreversible money movement. The unit comes from the HOST'S DECLARATION over
 * the tool's own input schema, never from the value's
 * magnitude — dressing a non-money integer as currency would be the same defect
 * pointing the other way. Undeclared money says so out loud rather than looking
 * like dollars.
 */
export function argValue(field: string, value: unknown, properties: ArgProperties): string {
  const raw = String(value);
  if (typeof value === "boolean") return yesNo(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return raw;
  const unit = declaredMoneyUnit(field, properties?.[field]);
  if (unit === undefined) return raw;
  // Fractional "cents" is not cents at all (the contradiction `amountUnitIssue`
  // refuses at the call seam) — undeclared, rather than round someone's money.
  if (unit === "cents" && Number.isInteger(value)) return formatMoney(value) ?? raw;
  if (unit === "dollars") {
    const minor = Math.round(value * 10 ** currencyMinorUnits(getKitIntl().currency));
    return formatMoney(minor) ?? raw;
  }
  return `${raw} (unit not specified)`;
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
