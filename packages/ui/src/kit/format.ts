/**
 * Kit semantics core — the Intl formatters the KIT ITSELF still needs.
 *
 * The value-formatting tier is gone: a screen formats its own figures with
 * `Intl`, which the VM bridges (`genui/component/vm-program.ts`), so nothing here
 * is model-facing any more — the charts were the last holdout, and their `format`
 * tokens are now the screen's own per-row functions (`charts/sanitize.tsx`).
 * What is left serves the three places a displayed value never passes through the
 * model's code at all: the chrome's own rendering of tool arguments, the digit
 * grouping a chart falls back to on an axis the screen cannot reach, one form
 * control's own affordance (DateRange) — plus the total text coercion every
 * container uses to turn an absent field into a designed placeholder.
 *
 * Every formatter is still total: bad data (NaN, Infinity, unparseable dates)
 * returns `null`, never `$NaN` on an axis.
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
 * `formatNum` runs inside every chart's axis and `formatMoney` inside the
 * chrome's humanizer. React
 * context cannot reach those call sites, so a host that bills in rupees would
 * otherwise be stuck with the hardcoded "$" no matter what its tool semantics
 * declare.
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
 * ISO 4217 minor units, for the currencies that are not the 2-digit default —
 * how many decimals an amount SHOWS.
 *
 * The count CANNOT come from `resolvedOptions().maximumFractionDigits`: that is
 * a locale DISPLAY preference out of CLDR, and for some currencies it genuinely
 * disagrees with the ISO minor unit. PKR is the case that bit us — Node's ICU
 * reports 2 digits, Chrome's reports 0 — so the identical amount rendered
 * "PKR 107.68" on the server and "PKR 108" in the browser. A static table is
 * the only engine-independent answer.
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
 * Pretty-print an amount that is ALREADY in major units: `1234.56` → `"$1,234.56"`.
 *
 * Formatters never convert units. Callers pass major units, so a host field in
 * minor units (cents) is divided by 100 where it is READ, never here. The ISO
 * minor unit still decides how many decimals SHOW — none for JPY, three for KWD.
 * Returns `null` for any non-finite or absent input so `$NaN` can never ship.
 */
export function formatMoney(amount: number | undefined, options: MoneyOptions = {}): string | null {
  if (!isRenderableNumber(amount)) return null;
  const currency = options.currency ?? ambientIntl.currency;
  const digits = currencyMinorUnits(currency);
  let formatter: Intl.NumberFormat;
  try {
    // Pin the displayed digits to the ISO minor unit: left to CLDR, a browser
    // would round PKR 107.68 to "PKR 108" and silently drop the paisa the host
    // actually stored.
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
  return formatter.format(amount);
}

export interface NumOptions {
  maximumFractionDigits?: number;
  minimumFractionDigits?: number;
  notation?: "standard" | "compact";
  /** A unit written after the figure — "ms", "min", "h", "GB". Not `Intl`'s
   *  `style: "unit"`: that takes a fixed vocabulary ("millisecond"), and the
   *  short word a host actually uses is not always in it. */
  unit?: string;
  locale?: string;
}

/**
 * Format a plain number with thousands grouping. Returns `null` if non-finite.
 *
 * A CHART AXIS is what this is left for inside the Kit, and it is the one figure
 * a screen's own formatter cannot reach: recharts invents an axis tick off the
 * scale, so it is a number the screen never held a row of. Grouping is all the
 * Kit will do to one — 285000 reads "285,000" and never "$285,000", because what
 * the number MEANS is the screen's to say and the chart is not told.
 */
export function formatNum(value: number | undefined, options: NumOptions = {}): string | null {
  if (!isRenderableNumber(value)) return null;
  const text = new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
    notation: options.notation ?? "standard",
    maximumFractionDigits: options.maximumFractionDigits,
    minimumFractionDigits: options.minimumFractionDigits,
  }).format(value);
  return options.unit === undefined ? text : `${text} ${options.unit}`;
}

export type DateInput = string | number | Date;

export interface DateTimeOptions {
  /** date = calendar day · time = clock · datetime = both · relative = "3 days ago". */
  mode?: "date" | "time" | "datetime" | "relative";
  /** Drop the year ("Aug 12"), for somewhere narrow like a table cell. */
  compact?: boolean;
  locale?: string;
  timeZone?: string;
}

/**
 * The one string shape the Kit will PARSE — ISO 8601, naming a full day at
 * least. A string that names less than that is already display text, and handing
 * it to `new Date` buys a GUESS: V8's fallback parser fills a missing year with
 * 2001, so "Aug 15, 7:42 AM" came back as August 15th 2001 and a timeline dated
 * every entry twenty-five years ago. "Week 1" parses too, to New Year's Day 2001.
 * A formatter may render nothing, but it may never invent the part it was not
 * told, so anything looser is refused here and reads as itself at the call site.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}/u;

function toDate(value: DateInput | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null;
  if (typeof value === "string" && ISO_DAY.test(value.trim())) {
    const d = new Date(value.trim());
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
 * Format a date/time. Accepts ISO strings, epoch millis, or `Date` — and ONLY
 * those. Returns `null` for anything else, including a stamp that is already
 * written for a reader ("Aug 15, 7:42 AM"), which the caller shows as it stands.
 *
 * KNOWN COST of the value tier's removal: this totality now covers only the
 * places the KIT still formats — the chrome, and DateRange's own range. A screen writes
 * `new Date(row.due).toLocaleDateString(…)` in its own code, and an unparseable
 * stamp there renders the literal "Invalid Date" where the tier used to paint a
 * muted dash. Accepted: the dash was worth less than one road for every figure.
 */
export function formatDateTime(value: DateInput | undefined, options: DateTimeOptions = {}): string | null {
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
  const clock: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  const parts: Intl.DateTimeFormatOptions =
    mode === "time"
      ? clock
      : {
          // The year is the part a narrow column can afford to lose: dates in a
          // table are overwhelmingly this year, and it reads as noise repeated
          // down every row.
          ...(options.compact ? {} : { year: "numeric" }),
          month: "short",
          day: "numeric",
          // A date-only value carries no clock, so `datetime` shows the day
          // alone: the alternative is stamping "12:00 AM" on every row, which
          // is a time the host never said.
          ...(mode === "datetime" && !dateOnly ? clock : {}),
        };
  return new Intl.DateTimeFormat(locale, { ...base, ...parts }).format(date);
}

/**
 * What is left of the format union: `text`, and the one control that still reads
 * a `date` for itself.
 *
 * There is NO model-facing token any more. The chart tokens were the last of them
 * — `money`, `number`, `duration`, `datetime`, `time` all died with the charts'
 * own `format`, which is a function the screen writes now — so this union is
 * purely internal, and nothing outside `@vendoai/ui` names a member of it.
 * `text` is its floor: the total coercion the containers read through it, which is
 * what turns an absent field into a designed placeholder. `date` is `DateRange`'s
 * own affordance — a date picker draws the range it holds, and the range is the
 * control's state rather than a figure the screen handed it.
 */
export type ValueFormat = "date" | "text";

/** Apply a `ValueFormat` token to a raw value, returning `null` when unrenderable. */
export function applyFormat(value: unknown, format: ValueFormat = "text"): string | null {
  switch (format) {
    case "date":
      return typeof value === "string" || typeof value === "number" || value instanceof Date
        ? formatDateTime(value as DateInput, { mode: format })
        : null;
    case "text":
    default: {
      if (value === null || value === undefined) return null;
      const text = String(value);
      // ABSENT is the totality that survives: `null` here is what turns a bare
      // "Bank:" label into "Bank: —" everywhere a container renders label/value
      // pairs (Stat, CardList, DataTable cells).
      //
      // KNOWN COST of the value tier's removal: a NaN no longer collapses with
      // it. The numeric tokens screened one out and painted the dash; a container
      // now coerces whatever it is handed, so a NaN that reaches a cell prints
      // "NaN". Nothing is lost by it — a screen's own `(0/0).toLocaleString()`
      // prints "NaN" too, so this is the same figure the model would have written
      // — and the honest reading is that bad arithmetic is now visible rather
      // than disguised as missing data.
      return text.trim() === "" ? null : text;
    }
  }
}
