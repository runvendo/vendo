/**
 * Kit semantics core — Intl-based formatters (W2 §The Kit).
 *
 * The whole point of the value tier: cents/dates/enums arrive CORRECT without the
 * model ever authoring a format string. Every formatter is total — bad data
 * (NaN, Infinity, non-numbers, unparseable dates) returns `null`, never the
 * strings `$NaN` / `Invalid Date`. Components turn `null` into a designed
 * placeholder, so garbage from generation is structurally unrenderable.
 */

/** A finite, real JS number — the only thing the numeric tier will format. */
export function isRenderableNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface MoneyOptions {
  /** ISO 4217 code; defaults to USD. */
  currency?: string;
  /** BCP-47 locale; defaults to en-US. */
  locale?: string;
}

/**
 * Format an **integer number of cents** (the minor unit) as currency.
 * `123456` → `"$1,234.56"`. Zero-decimal currencies (JPY) are handled by Intl.
 * Returns `null` for any non-finite input so `$NaN` can never ship.
 */
export function formatMoney(cents: number, options: MoneyOptions = {}): string | null {
  if (!isRenderableNumber(cents)) return null;
  const currency = options.currency ?? "USD";
  const formatter = new Intl.NumberFormat(options.locale ?? "en-US", { style: "currency", currency });
  // Divide by the currency's actual minor-unit exponent (2 for USD, 0 for JPY).
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(cents / 10 ** fractionDigits);
}

export interface PercentOptions {
  /** Digits after the decimal point; defaults to 0. */
  fractionDigits?: number;
  /** When true, the input is already a whole percentage (42, not 0.42). */
  whole?: boolean;
  locale?: string;
}

/**
 * Format a ratio (`0.42` → `"42%"`). Pass `whole: true` when the value is already
 * a whole percentage. Returns `null` for non-finite input.
 */
export function formatPercent(value: number, options: PercentOptions = {}): string | null {
  if (!isRenderableNumber(value)) return null;
  const ratio = options.whole ? value / 100 : value;
  return new Intl.NumberFormat(options.locale ?? "en-US", {
    style: "percent",
    minimumFractionDigits: options.fractionDigits ?? 0,
    maximumFractionDigits: options.fractionDigits ?? 0,
  }).format(ratio);
}

export interface NumOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  notation?: "standard" | "compact";
  locale?: string;
}

/** Format a plain number with thousands grouping. Returns `null` if non-finite. */
export function formatNum(value: number, options: NumOptions = {}): string | null {
  if (!isRenderableNumber(value)) return null;
  return new Intl.NumberFormat(options.locale ?? "en-US", {
    notation: options.notation ?? "standard",
    maximumFractionDigits: options.maximumFractionDigits,
    minimumFractionDigits: options.minimumFractionDigits,
  }).format(value);
}

export type DateInput = string | number | Date;

export interface DateTimeOptions {
  /** date = calendar day · time = clock · datetime = both · relative = "3 days ago". */
  mode?: "date" | "time" | "datetime" | "relative";
  locale?: string;
  timeZone?: string;
}

function toDate(value: DateInput): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === "string") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const RELATIVE_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["week", 1000 * 60 * 60 * 24 * 7],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
];

/**
 * Format a date/time. Accepts ISO strings, epoch millis, or `Date`. Returns
 * `null` for anything unparseable so `Invalid Date` can never ship.
 */
export function formatDateTime(value: DateInput, options: DateTimeOptions = {}): string | null {
  const date = toDate(value);
  if (!date) return null;
  const mode = options.mode ?? "date";
  const locale = options.locale ?? "en-US";
  // A date-only ISO string ("2026-03-14") is parsed as UTC midnight; formatting
  // it in a behind-UTC local zone would slip it to the previous calendar day.
  // Pin such values to UTC so the day the host meant is the day we show.
  const dateOnly = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
  const timeZone = options.timeZone ?? (dateOnly ? "UTC" : undefined);
  if (mode === "relative") {
    const diff = date.getTime() - Date.now();
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    for (const [unit, ms] of RELATIVE_STEPS) {
      if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
    }
    return rtf.format(Math.round(diff / 1000), "second");
  }
  const base: Intl.DateTimeFormatOptions = { timeZone };
  const parts: Intl.DateTimeFormatOptions =
    mode === "time"
      ? { hour: "numeric", minute: "2-digit" }
      : mode === "datetime"
        ? { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
        : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, { ...base, ...parts }).format(date);
}

/** The value-tier `format` union — the same tokens a DataTable column accepts. */
export type ValueFormat = "money" | "date" | "datetime" | "time" | "percent" | "number" | "text";

/** Apply a `ValueFormat` token to a raw value, returning `null` when unrenderable. */
export function applyFormat(value: unknown, format: ValueFormat = "text"): string | null {
  switch (format) {
    case "money":
      return typeof value === "number" ? formatMoney(value) : null;
    case "percent":
      return typeof value === "number" ? formatPercent(value) : null;
    case "number":
      return typeof value === "number" ? formatNum(value) : null;
    case "date":
    case "datetime":
    case "time":
      return typeof value === "string" || typeof value === "number" || value instanceof Date
        ? formatDateTime(value as DateInput, { mode: format })
        : null;
    case "text":
    default: {
      if (value === null || value === undefined) return null;
      const text = String(value);
      // An empty/whitespace field is unrenderable like NaN is: `null` here is
      // what turns a bare "Bank:" label into "Bank: —" everywhere the data
      // tier renders label/value pairs (Stat, CardList, DataTable cells).
      return text.trim() === "" ? null : text;
    }
  }
}
