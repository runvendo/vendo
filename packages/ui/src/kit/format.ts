/**
 * Kit semantics core — Intl-based formatters (W2 §The Kit).
 *
 * The whole point of the value tier: amounts/dates/enums arrive CORRECT without the
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
 * `applyFormat` runs inside DataTable/CardList/Stat/every chart, and the mount
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

export interface PercentOptions {
  /** Digits after the decimal point; pins both ends when given. */
  fractionDigits?: number;
  locale?: string;
}

/**
 * Print a percentage AS GIVEN: `46.1` → `"46.1%"`, `7.25` → `"7.25%"`.
 *
 * Formatters never convert, and this one is where that law was being broken.
 * `Intl`'s own `style: "percent"` multiplies by 100, so the tier took a RATIO and
 * every host field named `*_pct` — already on a 0-100 scale, which is how hosts
 * store one — printed as "4,610%". The ×100 convention that was supposed to
 * prevent it just moved the same error into the screen, where a model had to
 * remember it. So: no multiply anywhere, and a 0..1 ratio is `* 100` where the
 * data is PREPARED, exactly as a cents field is `/ 100` there.
 *
 * The suffix is appended rather than left to `Intl` for that reason alone —
 * `style: "percent"` cannot be asked not to scale. `formatNum` appends its unit
 * the same way, and for a related reason: the short word a host uses is not
 * always one `Intl` has.
 *
 * And the tier never rounds a figure it was not asked to round: decimals show
 * only where the number has them, up to two, so 7.25% cannot print as "7%".
 * `fractionDigits` pins them. Returns `null` for non-finite input.
 */
export function formatPercent(value: number | undefined, options: PercentOptions = {}): string | null {
  if (!isRenderableNumber(value)) return null;
  return `${new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
    minimumFractionDigits: options.fractionDigits ?? 0,
    maximumFractionDigits: options.fractionDigits ?? 2,
  }).format(value)}%`;
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

/** Format a plain number with thousands grouping. Returns `null` if non-finite. */
export function formatNum(value: number | undefined, options: NumOptions = {}): string | null {
  if (!isRenderableNumber(value)) return null;
  const text = new Intl.NumberFormat(options.locale ?? ambientIntl.locale, {
    notation: options.notation ?? "standard",
    maximumFractionDigits: options.maximumFractionDigits,
    minimumFractionDigits: options.minimumFractionDigits,
  }).format(value);
  return options.unit === undefined ? text : `${text} ${options.unit}`;
}

/** The duration units, largest first, and the seconds each one holds. */
const DURATION_UNITS: ReadonlyArray<readonly [string, number]> = [
  ["d", 86_400], ["h", 3_600], ["m", 60], ["s", 1],
];

export interface DurationOptions {
  /** What one unit of the count IS — seconds (default) or minutes. */
  unit?: "seconds" | "minutes";
  /** Phrase the sign instead of printing it: a positive count is time still
   *  to come ("3h 20m left"), a negative one is time already past
   *  ("overdue 1h 55m"). */
  signed?: boolean;
}

/**
 * A count of time as a duration: `268` → `"4m 28s"`, `46` → `"46s"`,
 * `9480` → `"2h 38m"`. The two largest non-zero units and no more — "1h 5m 3s"
 * is three figures where a person reads one — and under half a second is `"0s"`.
 *
 * Seconds unless `unit` says minutes. The `* 60` used to be the caller's job,
 * the way a cents field is `/ 100` — but hosts store `minutes_remaining` at
 * least as often as a seconds field, and a forgotten multiply here is INVISIBLE:
 * 200 minutes read as seconds printed "3m 20s", a plausible duration off by 60×.
 * A unit that is declared cannot be forgotten. Money keeps the caller's divide
 * because there the two units differ per currency, so there is no one token to
 * name; time's do not.
 *
 * `signed` phrases the sign instead of printing it. A bare "-1h 55m" in an SLA
 * column reads as a negative quantity of time, which is not a thing — the word
 * is what says which side of the deadline the row is on. Zero stays the plain
 * "0s" either way: everything under half a second rounds to it, and neither
 * "0s left" nor "overdue 0s" is a claim that count can support.
 *
 * Hand-rolled rather than `Intl.DurationFormat`: it is absent from engines this
 * still ships on, which is the same engine drift `MINOR_UNITS` exists for.
 */
export function formatDuration(count: number | undefined, options: DurationOptions = {}): string | null {
  if (!isRenderableNumber(count)) return null;
  const seconds = options.unit === "minutes" ? count * 60 : count;
  let rest = Math.round(Math.abs(seconds));
  const parts: string[] = [];
  for (const [suffix, size] of DURATION_UNITS) {
    const units = Math.floor(rest / size);
    rest -= units * size;
    if (units > 0) parts.push(`${units}${suffix}`);
    if (parts.length === 2) break;
  }
  if (parts.length === 0) return "0s";
  const figure = parts.join(" ");
  if (!options.signed) return `${seconds < 0 ? "-" : ""}${figure}`;
  return seconds < 0 ? `overdue ${figure}` : `${figure} left`;
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

function toDate(value: DateInput | undefined): Date | null {
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

/** The value-tier `format` union — the same tokens a DataTable column accepts.
 *  `code` is text with a FACE: an identifier (a sha, a branch, an id) reads in
 *  the host's mono, so there is nothing here to format and the face is applied
 *  where the cell is painted. */
export type ValueFormat = "money" | "date" | "datetime" | "time" | "number" | "duration" | "text" | "code";

/**
 * Apply a `ValueFormat` token to a raw value, returning `null` when unrenderable.
 *
 * The third argument is the DURATION options and nothing else, because duration
 * is the only token that takes any: a count needs its unit and its sign named,
 * where a date or an amount reads correctly from the token alone. It is spelled
 * `duration` rather than `options` so the next reader grows a sibling argument
 * instead of a per-token grab-bag that every one of the dozen call sites would
 * then have to thread.
 */
export function applyFormat(value: unknown, format: ValueFormat = "text", duration?: DurationOptions): string | null {
  switch (format) {
    case "money":
      return typeof value === "number" ? formatMoney(value) : null;
    case "number":
      return typeof value === "number" ? formatNum(value) : null;
    case "duration":
      return typeof value === "number" ? formatDuration(value, duration) : null;
    case "date":
    case "datetime":
    case "time":
      return typeof value === "string" || typeof value === "number" || value instanceof Date
        ? formatDateTime(value as DateInput, { mode: format })
        : null;
    case "code":
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
 * The formatter bundle, as one object. Generated code reads a bare `fmt`
 * (`ISLAND_AMBIENT_HELPER_NAMES`) and this barrel exports this same object into
 * code-land, so both venues format through ONE implementation.
 */
export const fmt = {
  money: formatMoney,
  percent: formatPercent,
  num: formatNum,
  duration: formatDuration,
  dateTime: formatDateTime,
  format: applyFormat,
};
