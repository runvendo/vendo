/**
 * The value tier — semantic, Intl-formatted, `$NaN`-proof (W2 §The Kit).
 * Money takes MAJOR units (dollars); dates take ISO/epoch/Date; percent takes a ratio.
 * Any unrenderable value collapses to a muted placeholder, never bad text.
 */
import { isValidElement, type CSSProperties, type ReactNode } from "react";
import {
  applyFormat,
  formatDateTime,
  formatMoney,
  formatNum,
  formatPercent,
  type DateInput,
  type DateTimeOptions,
  type MoneyOptions,
} from "./format.js";
import { useFieldValue } from "./row.js";
import { font, microLabel, numeric, resolveTone, t, toneColor, toneStyle, type KitStyled, type KitTone } from "./tokens.js";

const PLACEHOLDER = "—";

/**
 * What this component renders: the row's field when it is standing in a cell
 * slot and named one, its own prop otherwise. The cast is safe because every
 * formatter below is TOTAL — a field holding the wrong type comes back `null`
 * and renders the placeholder, exactly as NaN does.
 */
function useValue<T>(field: string | undefined, own: T): T {
  return useFieldValue(field, own) as T;
}

function Placeholder({ style }: KitStyled): ReactNode {
  return (
    <span data-kit="Placeholder" style={{ color: t.muted, ...style }} aria-hidden="true">
      {PLACEHOLDER}
    </span>
  );
}

/** A tone's paint, or nothing at all — an absent (or neutral) tone leaves the
 *  component's own color exactly as it was. The catalog teaches "the figure that
 *  is bad news is `danger`", so every figure has to answer to it. */
function tonePaint(tone: KitTone | undefined): CSSProperties {
  const resolved = resolveTone(tone);
  return resolved === "neutral" ? {} : { color: toneColor(resolved) };
}

export interface MoneyProps extends MoneyOptions, KitStyled {
  /** The amount in MAJOR units (dollars) — formatters never convert, so a cents
   *  field is divided by 100 before it gets here. */
  amount?: number;
  /** Paints the figure — an overdue amount is `danger`. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this amount comes from. */
  field?: string;
}

/** Currency from a major-unit amount. `<Money amount={1234.56}/>` → "$1,234.56". */
export function Money({ amount, currency, locale, tone, field, style }: MoneyProps) {
  const formatted = formatMoney(useValue(field, amount), { currency, locale });
  if (formatted === null) return <Placeholder style={style} />;
  return (
    <span data-kit="Money" style={{ ...font, ...numeric, ...tonePaint(tone), ...style }}>
      {formatted}
    </span>
  );
}

export interface DateTimeProps extends DateTimeOptions, KitStyled {
  value?: DateInput;
  /** Paints the date — a date that is bad news is `danger`. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this date comes from. */
  field?: string;
}

/** A date/time. `<DateTime value="2026-03-14" mode="date"/>` → "Mar 14, 2026". */
export function DateTime({ value, mode, locale, timeZone, compact, tone, field, style }: DateTimeProps) {
  const formatted = formatDateTime(useValue(field, value), { mode, locale, timeZone, compact });
  if (formatted === null) return <Placeholder style={style} />;
  return (
    <span data-kit="DateTime" style={{ ...font, ...tonePaint(tone), ...style }}>
      {formatted}
    </span>
  );
}

export interface PercentProps extends KitStyled {
  /** A ratio (0.42 → "42%") unless `whole`. */
  value?: number;
  fractionDigits?: number;
  whole?: boolean;
  /** Paints the figure — a `danger` share is how a breach reads red. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this ratio comes from. */
  field?: string;
}

/** A percentage from a ratio. `<Percent value={0.42}/>` → "42%". */
export function Percent({ value, fractionDigits, whole, tone, field, style }: PercentProps) {
  const formatted = formatPercent(useValue(field, value), { fractionDigits, whole });
  if (formatted === null) return <Placeholder style={style} />;
  return (
    <span data-kit="Percent" style={{ ...font, ...numeric, ...tonePaint(tone), ...style }}>
      {formatted}
    </span>
  );
}

export interface NumProps extends KitStyled {
  value?: number;
  maximumFractionDigits?: number;
  notation?: "standard" | "compact";
  /** A unit written after the figure — "ms", "min", "h". */
  unit?: string;
  /** Paints the figure — the count that is bad news is `danger`. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this number comes from. */
  field?: string;
}

/** A grouped number. `<Num value={1234567}/>` → "1,234,567". */
export function Num({ value, maximumFractionDigits, notation, unit, tone, field, style }: NumProps) {
  const formatted = formatNum(useValue(field, value), { maximumFractionDigits, notation, unit });
  if (formatted === null) return <Placeholder style={style} />;
  return (
    <span data-kit="Num" style={{ ...font, ...numeric, ...tonePaint(tone), ...style }}>
      {formatted}
    </span>
  );
}

/** The pill vocabulary is the ONE tone vocabulary; the name stays because
 *  Badge and the specs already speak it. */
export type EnumTone = KitTone;

/** Turn "past_due" / "pastDue" into "Past due". */
export function humanizeEnum(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface EnumBadgeProps extends KitStyled {
  /** The raw enum value from data. */
  value?: string | null;
  /** Optional value → display label overrides. */
  labels?: Record<string, string>;
  /** Optional value → tone overrides. */
  tones?: Record<string, EnumTone>;
  /** Fallback tone when no override matches. */
  tone?: EnumTone;
  /** Inside a cell slot: the row field this enum comes from. */
  field?: string;
}

/** A record entry the model authored, or nothing. `Object.hasOwn`, not a bare
 *  index: an enum value of "toString" would otherwise pick up
 *  `Object.prototype`'s member — a function handed to React as a child. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A status pill for enum fields — humanized label, tone-mapped color. */
export function EnumBadge({ value, labels, tones, tone, field, style }: EnumBadgeProps) {
  const key = applyFormat(useValue(field, value), "text");
  if (key === null) return null;
  const resolvedTone = resolveTone(own(tones, key) ?? tone);
  const paint = toneStyle[resolvedTone];
  const label = own(labels, key) ?? humanizeEnum(key);
  return (
    <span
      data-kit="EnumBadge"
      data-tone={resolvedTone}
      style={{
        ...font,
        display: "inline-flex",
        alignItems: "center",
        width: "fit-content",
        minHeight: "var(--vendo-density-badge-height, 24px)",
        border: `${t.borderWidth} solid ${paint.border}`,
        borderRadius: "999px",
        color: paint.color,
        background: paint.background,
        fontSize: "0.78em",
        fontWeight: t.weightEmphasis,
        lineHeight: 1,
        padding: "var(--vendo-density-badge-padding, 5px 9px)",
        ...style,
      }}
    >
      {label}
    </span>
  );
}

export interface TextProps extends KitStyled {
  text?: ReactNode;
  variant?: "body" | "heading" | "caption" | "label";
  /** Paints the text — a `danger` figure is how an overdue amount reads red. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this text comes from. */
  field?: string;
}

/** Themed text. Heading renders an <h3>; others render a <span>. */
export function Text({ text, variant = "body", tone, field, style }: TextProps) {
  // A row field holds ANYTHING: a plain object as a React child throws
  // ("Objects are not valid as a React child") and a boolean renders as
  // literally NOTHING, which is how `active: false` came out blank. An element
  // passes through as itself; every other value goes through the tier's total
  // coercion — an object never reaching the formatter, which would spell it
  // "[object Object]".
  //
  // ABSENT is not the same as unrenderable, and only Text can tell them apart:
  // a binding whose query has not answered yet resolves to undefined, and a
  // placeholder dash there reads as "no data" for data that is still on its
  // way. Nothing renders as nothing; the dash is for a value that arrived and
  // could not be shown.
  const value = useValue<ReactNode>(field, text);
  const content = isValidElement(value)
    ? value
    : value === undefined || value === null || value === ""
      ? null
      : (applyFormat(typeof value === "object" ? null : value, "text") ?? <Placeholder />);
  const rootStyle: CSSProperties = {
    ...font,
    // `label` IS the micro-label — the word over a figure, not prose. `caption`
    // stays sentence-case: it carries model-authored sentences, and uppercasing
    // a sentence costs more legibility than the rhythm buys.
    ...(variant === "label" ? microLabel : {}),
    ...(variant === "caption" ? { color: t.muted, fontSize: "var(--vendo-font-size-caption, 12.5px)" } : {}),
    ...(variant === "heading"
      ? { fontFamily: t.headingFamily, fontWeight: t.weightEmphasis, lineHeight: t.lineHeightHeading }
      : {}),
    margin: 0,
    ...tonePaint(tone),
    ...style,
  };
  if (variant === "heading") {
    return (
      <h3 data-kit="Text" data-variant={variant} style={rootStyle}>
        {content}
      </h3>
    );
  }
  return (
    <span data-kit="Text" data-variant={variant} style={rootStyle}>
      {content}
    </span>
  );
}
