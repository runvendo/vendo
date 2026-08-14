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
import { font, resolveTone, t, toneColor, toneStyle, type KitTone } from "./tokens.js";

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

function Placeholder(): ReactNode {
  return (
    <span data-kit="Placeholder" style={{ color: t.muted }} aria-hidden="true">
      {PLACEHOLDER}
    </span>
  );
}

const numeric: CSSProperties = { fontVariantNumeric: "tabular-nums" };

export interface MoneyProps extends MoneyOptions {
  /** The amount in MAJOR units (dollars) — formatters never convert, so a cents
   *  field is divided by 100 before it gets here. */
  amount?: number;
  /** Inside a cell slot: the row field this amount comes from. */
  field?: string;
}

/** Currency from a major-unit amount. `<Money amount={1234.56}/>` → "$1,234.56". */
export function Money({ amount, currency, locale, field }: MoneyProps) {
  const formatted = formatMoney(useValue(field, amount), { currency, locale });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Money" style={{ ...font, ...numeric }}>
      {formatted}
    </span>
  );
}

export interface DateTimeProps extends DateTimeOptions {
  value?: DateInput;
  /** Inside a cell slot: the row field this date comes from. */
  field?: string;
}

/** A date/time. `<DateTime value="2026-03-14" mode="date"/>` → "Mar 14, 2026". */
export function DateTime({ value, mode, locale, timeZone, compact, field }: DateTimeProps) {
  const formatted = formatDateTime(useValue(field, value), { mode, locale, timeZone, compact });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="DateTime" style={font}>
      {formatted}
    </span>
  );
}

export interface PercentProps {
  /** A ratio (0.42 → "42%") unless `whole`. */
  value?: number;
  fractionDigits?: number;
  whole?: boolean;
  /** Inside a cell slot: the row field this ratio comes from. */
  field?: string;
}

/** A percentage from a ratio. `<Percent value={0.42}/>` → "42%". */
export function Percent({ value, fractionDigits, whole, field }: PercentProps) {
  const formatted = formatPercent(useValue(field, value), { fractionDigits, whole });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Percent" style={{ ...font, ...numeric }}>
      {formatted}
    </span>
  );
}

export interface NumProps {
  value?: number;
  maximumFractionDigits?: number;
  notation?: "standard" | "compact";
  /** Inside a cell slot: the row field this number comes from. */
  field?: string;
}

/** A grouped number. `<Num value={1234567}/>` → "1,234,567". */
export function Num({ value, maximumFractionDigits, notation, field }: NumProps) {
  const formatted = formatNum(useValue(field, value), { maximumFractionDigits, notation });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Num" style={{ ...font, ...numeric }}>
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

export interface EnumBadgeProps {
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

/** A status pill for enum fields — humanized label, tone-mapped color. */
export function EnumBadge({ value, labels, tones, tone, field }: EnumBadgeProps) {
  const key = applyFormat(useValue(field, value), "text");
  if (key === null) return null;
  const resolvedTone = resolveTone(tones?.[key] ?? tone);
  const style = toneStyle[resolvedTone];
  const label = labels?.[key] ?? humanizeEnum(key);
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
        border: `1px solid ${style.border}`,
        borderRadius: "999px",
        color: style.color,
        background: style.background,
        fontSize: "0.78em",
        fontWeight: 700,
        lineHeight: 1,
        padding: "var(--vendo-density-badge-padding, 5px 9px)",
      }}
    >
      {label}
    </span>
  );
}

export interface TextProps {
  text?: ReactNode;
  variant?: "body" | "heading" | "caption" | "label";
  /** Paints the text — a `danger` figure is how an overdue amount reads red. */
  tone?: KitTone;
  /** Inside a cell slot: the row field this text comes from. */
  field?: string;
}

/** Themed text. Heading renders an <h3>; others render a <span>. */
export function Text({ text, variant = "body", tone, field }: TextProps) {
  // A row field holds ANYTHING, and a plain object as a React child throws
  // ("Objects are not valid as a React child") — so a non-node collapses to the
  // placeholder like every other unrenderable value in this tier.
  const value = useValue<ReactNode>(field, text);
  const content =
    typeof value === "object" && value !== null && !isValidElement(value) ? <Placeholder /> : value;
  const resolvedTone = resolveTone(tone);
  const style: CSSProperties = {
    color: resolvedTone !== "neutral" ? toneColor(resolvedTone) : variant === "caption" ? t.muted : t.text,
    fontFamily: variant === "heading" ? t.headingFamily : t.fontFamily,
    fontSize: variant === "caption" ? "var(--vendo-font-size-caption, 12.5px)" : t.fontSize,
    fontWeight: variant === "heading" ? 650 : variant === "label" ? 600 : 400,
    letterSpacing: "-0.011em",
    lineHeight: variant === "heading" ? 1.3 : 1.5,
    margin: 0,
  };
  if (variant === "heading") {
    return (
      <h3 data-kit="Text" data-variant={variant} style={style}>
        {content}
      </h3>
    );
  }
  return (
    <span data-kit="Text" data-variant={variant} style={style}>
      {content}
    </span>
  );
}
