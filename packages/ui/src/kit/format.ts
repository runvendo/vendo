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

/** The host's display currency + locale for every Kit formatter. */
export interface KitIntl {
  /** ISO 4217 code, e.g. "PKR". */
  currency: string;
  /** BCP-47 locale, e.g. "en-PK". */
  locale: string;
}

const FALLBACK_INTL: KitIntl = { currency: "USD", locale: "en-US" };

/**
 * Ambient, because the Kit's formatters are PURE FUNCTIONS, not components:
 * `applyFormat` runs inside DataTable/CardList/Stat/every chart, and the jail
 * hands islands a bare `fmt.money`. React context cannot reach those call
 * sites, so a host that bills in rupees would otherwise be stuck with the
 * hardcoded "$" no matter what its tool semantics declare.
 *
 * Set once per host (VendoProvider does it from its `intl` prop). One page =
 * one display currency; a per-value currency still wins via the options
 * argument, which is how a genuinely multi-currency row renders.
 */
let ambientIntl: KitIntl = FALLBACK_INTL;

/** Does Intl accept this pair, or would every amount throw at render time? */
function isUsableIntl(currency: string, locale: string): boolean {
  try {
    new Intl.NumberFormat(locale, { style: "currency", currency });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the ambient currency/locale. Unspecified fields RESET to the
 * built-in default rather than merging with whatever ran before, so the same
 * input always produces the same state regardless of call order.
 *
 * A currency/locale Intl rejects is dropped for the default: a typo in host
 * config costs the "$" it would have fixed, never a screen of placeholders.
 */
export function setKitIntl(next: Partial<KitIntl> | undefined): void {
  const candidate = {
    currency: next?.currency ?? FALLBACK_INTL.currency,
    locale: next?.locale ?? FALLBACK_INTL.locale,
  };
  ambientIntl = isUsableIntl(candidate.currency, candidate.locale) ? candidate : FALLBACK_INTL;
}

/** The currency/locale every formatter falls back to. */
export function getKitIntl(): KitIntl {
  return ambientIntl;
}

export interface MoneyOptions {
  /** ISO 4217 code; defaults to the ambient currency (USD until set). */
  currency?: string;
  /** BCP-47 locale; defaults to the ambient locale (en-US until set). */
  locale?: string;
}

/**
 * ISO 4217 minor units, for the currencies that are not the 2-digit default.
 *
 * The divisor CANNOT come from `resolvedOptions().maximumFractionDigits`: that
 * is a locale DISPLAY preference out of CLDR, and for some currencies it
 * genuinely disagrees with the ISO minor unit. PKR is the case that bit us —
 * Node's ICU reports 2 digits, Chrome's reports 0 — so the identical paisa
 * amount formatted as "PKR 107.68" on the server and "PKR 10,768" in the
 * browser. A static table is the only engine-independent answer.
 */
const MINOR_UNITS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4,
};

/** How many minor units make one major unit of `currency`. */
export function currencyMinorUnits(currency: string): number {
  return MINOR_UNITS[currency.toUpperCase()] ?? 2;
}

/**
 * Format an **integer number of minor units** as currency.
 * `123456` → `"$1,234.56"`. Zero-decimal (JPY) and three-decimal (KWD)
 * currencies scale by their own ISO minor unit.
 * Returns `null` for any non-finite input so `$NaN` can never ship.
 */
export function formatMoney(cents: number, options: MoneyOptions = {}): string | null {
  if (!isRenderableNumber(cents)) return null;
  const currency = options.currency ?? ambientIntl.currency;
  const digits = currencyMinorUnits(currency);
  let formatter: Intl.NumberFormat;
  try {
    // Pin the displayed digits to the ISO minor unit too: left to CLDR, a
    // browser would round PKR 107.68 to "PKR 108" and silently drop the paisa
    // the host actually stored.
    formatter = new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  } catch {
    // A per-value `currency` is model-authored, so an invalid code is reachable
    // from generation. Stay total like the rest of the tier: placeholder, not a
    // thrown RangeError that takes the whole view down.
    return null;
  }
  return formatter.format(cents / 10 ** digits);
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
  return new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
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
  return new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
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
  const locale = options.locale ?? ambientIntl.locale;
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

/**
 * The formatter bundle, as one object. The jail hands islands a bare `fmt`
 * (`ISLAND_AMBIENT_HELPER_NAMES`) and this barrel exports this same object into
 * code-land, so both venues format through ONE implementation.
 */
export const fmt = {
  money: formatMoney,
  percent: formatPercent,
  num: formatNum,
  dateTime: formatDateTime,
  format: applyFormat,
};
