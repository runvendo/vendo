import type { Json } from "./ids.js";

/**
 * Usage & pricing v3 (spec §5) — the Cloud services' meter refusal, surfaced
 * honestly client-side. Every Vendo Cloud door refuses exhausted meters with
 * HTTP 402, the stable code `meter-exhausted`, and one structured body:
 * `{ meter, used, limit, resets_at, reason, exits: { upgrade_url,
 * byo_docs_url } }`. That body is the ONLY source of truth — OSS performs no
 * entitlement checks of any kind (locked constraint); this module just
 * recognizes the shape and renders it as one operator-grade sentence, reused
 * verbatim by the thread banner (via the agent's safe stream-error rail), the
 * CLI, and doctor.
 */
export interface MeterExhausted {
  /** The refused meter's canonical id (e.g. `ai_tokens`) — or undefined when
   *  the body carried none / an unprintable value (the format falls back). */
  meter?: string;
  used?: number;
  limit?: number;
  /** ISO timestamp; kept verbatim (format renders just the date part). */
  resetsAt?: string;
  /** Short refusal reason token from the body (e.g. `allowance`, `spend-cap`). */
  reason?: string;
  upgradeUrl?: string;
  byoDocsUrl?: string;
}

/** The console's stable refusal code (one shape, all services). */
export const METER_EXHAUSTED_CODE = "meter-exhausted";

/** The six canonical meters' human labels. An unknown meter falls back to its
 *  raw id (new Cloud meters stay nameable without an OSS release) — and to
 *  plain "usage" when the body carried nothing printable. */
const METER_LABELS: Record<string, string> = {
  ai_tokens: "AI tokens",
  sandbox_minutes: "sandbox minutes",
  storage_gb: "storage",
  knowledge_gb: "knowledge storage",
  automation_runs: "automation runs",
  active_connections: "active connections",
};

/** Only short machine-token strings from the body are ever rendered — the
 *  message stays operator-grade even against a garbled body. */
const TOKEN = /^[a-z0-9_.:-]{1,64}$/i;

const asToken = (value: unknown): string | undefined =>
  typeof value === "string" && TOKEN.test(value) ? value : undefined;

const asCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** URLs are the one rendered field without a token grammar, so they get the
 *  hardest treatment: the WHATWG-serialized href is returned (percent-encoding
 *  C0 controls — a raw `\x1b[2K` in the body must never reach a terminal), and
 *  anything longer than 200 chars serialized is dropped entirely (the format
 *  degrades to link-less exit naming). */
const MAX_URL_LENGTH = 200;

const asHttpUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.href.length <= MAX_URL_LENGTH ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Recognize the meter-exhausted refusal in a parsed 402 body. Tolerant to the
 * envelope: the stable code and the fields are read from the body root and
 * from its `error` member (the console's enveloped-error twin), the `error`
 * member winning where both carry a field. Anything that isn't the shape →
 * undefined (callers keep their existing 402 mapping).
 */
export function parseMeterExhausted(payload: unknown): MeterExhausted | undefined {
  const root = record(payload);
  if (root === undefined) return undefined;
  const enveloped = record(root["error"]);
  const code = [root["code"], enveloped?.["code"]].find((value) => value === METER_EXHAUSTED_CODE);
  if (code === undefined) return undefined;
  const read = (key: string): unknown => enveloped?.[key] ?? root[key];
  const exits = record(read("exits"));
  const result: MeterExhausted = {};
  const meter = asToken(read("meter"));
  if (meter !== undefined) result.meter = meter;
  const used = asCount(read("used"));
  if (used !== undefined) result.used = used;
  const limit = asCount(read("limit"));
  if (limit !== undefined) result.limit = limit;
  const resetsAt = typeof read("resets_at") === "string" ? (read("resets_at") as string) : undefined;
  if (resetsAt !== undefined) result.resetsAt = resetsAt;
  const reason = asToken(read("reason"));
  if (reason !== undefined) result.reason = reason;
  const upgradeUrl = asHttpUrl(exits?.["upgrade_url"]);
  if (upgradeUrl !== undefined) result.upgradeUrl = upgradeUrl;
  const byoDocsUrl = asHttpUrl(exits?.["byo_docs_url"]);
  if (byoDocsUrl !== undefined) result.byoDocsUrl = byoDocsUrl;
  return result;
}

/**
 * Recognize the refusal on a thrown error object — the model gateway's 402
 * reaches the agent as a provider APICallError carrying the raw response
 * body/data, never as a VendoError. Only OUR formatter's output ever renders
 * from it, so the safe-error policy (ENG-214) holds.
 */
export function meterExhaustedFromError(error: unknown): MeterExhausted | undefined {
  const carrier = record(error);
  if (carrier === undefined) return undefined;
  if (typeof carrier["responseBody"] === "string") {
    let body: unknown;
    try {
      body = JSON.parse(carrier["responseBody"]);
    } catch {
      body = undefined;
    }
    const parsed = parseMeterExhausted(body);
    if (parsed !== undefined) return parsed;
  }
  return parseMeterExhausted(carrier["data"]);
}

const count = new Intl.NumberFormat("en-US");

const resetDate = (resetsAt: string | undefined): string | undefined => {
  if (resetsAt === undefined) return undefined;
  const time = Date.parse(resetsAt);
  return Number.isNaN(time) ? undefined : new Date(time).toISOString().slice(0, 10);
};

/**
 * The one user-visible refusal sentence: names the meter, the usage-vs-limit
 * figures and reset date when the body carried them, and the two exits
 * (spec §5: upgrade / BYO) at the body's own URLs — the refusal body is the
 * only source of truth, so no URL is ever invented client-side; a partial
 * body degrades to naming the exits without links. The thread banner, the
 * CLI, and doctor all print exactly this.
 */
export function formatMeterExhausted(refusal: MeterExhausted): string {
  const label = refusal.meter === undefined ? "usage" : METER_LABELS[refusal.meter] ?? refusal.meter;
  const head = refusal.reason === "spend-cap"
    ? `Vendo Cloud paused ${label} — your spend cap is reached`
    : `Vendo Cloud paused ${label} — the allowance for this billing period is used up`;
  const figures = refusal.used !== undefined && refusal.limit !== undefined
    ? `${count.format(refusal.used)} of ${count.format(refusal.limit)} used`
    : undefined;
  const resets = resetDate(refusal.resetsAt);
  const clauses = [figures, resets === undefined ? undefined : `resets ${resets}`]
    .filter((clause): clause is string => clause !== undefined);
  const detail = clauses.length > 0 ? ` (${clauses.join("; ")})` : "";
  const upgrade = refusal.upgradeUrl === undefined ? "Upgrade your plan" : `Upgrade your plan (${refusal.upgradeUrl})`;
  const byo = refusal.byoDocsUrl === undefined
    ? "bring your own infrastructure"
    : `bring your own infrastructure (${refusal.byoDocsUrl})`;
  return `${head}${detail}. ${upgrade} or ${byo}.`;
}

/** The refusal as VendoError detail (Json), so programmatic consumers keep the
 *  structured fields alongside the crafted message. */
export function meterExhaustedDetail(refusal: MeterExhausted): Json {
  return Object.fromEntries(
    Object.entries(refusal).filter(([, value]) => value !== undefined),
  ) as Json;
}
