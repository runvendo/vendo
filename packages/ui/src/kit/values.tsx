/**
 * The value tier — semantic, Intl-formatted, `$NaN`-proof (W2 §The Kit).
 * Money takes integer CENTS; dates take ISO/epoch/Date; percent takes a ratio.
 * Any unrenderable value collapses to a muted placeholder, never bad text.
 */
import type { CSSProperties, ReactNode } from "react";
import {
  formatDateTime,
  formatMoney,
  formatNum,
  formatPercent,
  type DateInput,
  type DateTimeOptions,
  type MoneyOptions,
} from "./format.js";
import { font, t } from "./tokens.js";

const PLACEHOLDER = "—";

function Placeholder(): ReactNode {
  return (
    <span data-kit="Placeholder" style={{ color: t.muted }} aria-hidden="true">
      {PLACEHOLDER}
    </span>
  );
}

const numeric: CSSProperties = { fontVariantNumeric: "tabular-nums" };

export interface MoneyProps extends MoneyOptions {
  /** Amount in integer cents (minor units). */
  cents: number;
}

/** Currency from integer cents. `<Money cents={123456}/>` → "$1,234.56". */
export function Money({ cents, currency, locale }: MoneyProps) {
  const formatted = formatMoney(cents, { currency, locale });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Money" style={{ ...font, ...numeric }}>
      {formatted}
    </span>
  );
}

export interface DateTimeProps extends DateTimeOptions {
  value: DateInput;
}

/** A date/time. `<DateTime value="2026-03-14" mode="date"/>` → "Mar 14, 2026". */
export function DateTime({ value, mode, locale, timeZone }: DateTimeProps) {
  const formatted = formatDateTime(value, { mode, locale, timeZone });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="DateTime" style={font}>
      {formatted}
    </span>
  );
}

export interface PercentProps {
  /** A ratio (0.42 → "42%") unless `whole`. */
  value: number;
  fractionDigits?: number;
  whole?: boolean;
}

/** A percentage from a ratio. `<Percent value={0.42}/>` → "42%". */
export function Percent({ value, fractionDigits, whole }: PercentProps) {
  const formatted = formatPercent(value, { fractionDigits, whole });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Percent" style={{ ...font, ...numeric }}>
      {formatted}
    </span>
  );
}

export interface NumProps {
  value: number;
  maximumFractionDigits?: number;
  notation?: "standard" | "compact";
}

/** A grouped number. `<Num value={1234567}/>` → "1,234,567". */
export function Num({ value, maximumFractionDigits, notation }: NumProps) {
  const formatted = formatNum(value, { maximumFractionDigits, notation });
  if (formatted === null) return <Placeholder />;
  return (
    <span data-kit="Num" style={{ ...font, ...numeric }}>
      {formatted}
    </span>
  );
}

export type EnumTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_STYLE: Record<EnumTone, { color: string; background: string; border: string }> = {
  neutral: {
    color: t.text,
    background: `color-mix(in srgb, ${t.muted} 10%, ${t.surface})`,
    border: t.border,
  },
  accent: { color: t.accentText, background: t.accent, border: t.accent },
  success: {
    color: "color-mix(in srgb, #1e7f53 88%, #000)",
    background: "color-mix(in srgb, #1e7f53 12%, var(--vendo-color-surface, #ffffff))",
    border: "color-mix(in srgb, #1e7f53 30%, var(--vendo-color-border, #e3e3e8))",
  },
  warning: {
    color: "color-mix(in srgb, #9a6700 90%, #000)",
    background: "color-mix(in srgb, #d4a017 16%, var(--vendo-color-surface, #ffffff))",
    border: "color-mix(in srgb, #d4a017 34%, var(--vendo-color-border, #e3e3e8))",
  },
  danger: {
    color: t.danger,
    background: `color-mix(in srgb, ${t.danger} 11%, ${t.surface})`,
    border: `color-mix(in srgb, ${t.danger} 30%, ${t.border})`,
  },
};

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
  value: string | null | undefined;
  /** Optional value → display label overrides. */
  labels?: Record<string, string>;
  /** Optional value → tone overrides. */
  tones?: Record<string, EnumTone>;
  /** Fallback tone when no override matches. */
  tone?: EnumTone;
}

/** A status pill for enum fields — humanized label, tone-mapped color. */
export function EnumBadge({ value, labels, tones, tone = "neutral" }: EnumBadgeProps) {
  if (value === null || value === undefined || value === "") return null;
  const resolvedTone = tones?.[value] ?? tone;
  const style = TONE_STYLE[resolvedTone];
  const label = labels?.[value] ?? humanizeEnum(value);
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
  text: ReactNode;
  variant?: "body" | "heading" | "caption" | "label";
}

/** Themed text. Heading renders an <h3>; others render a <span>. */
export function Text({ text, variant = "body" }: TextProps) {
  const style: CSSProperties = {
    color: variant === "caption" ? t.muted : t.text,
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
        {text}
      </h3>
    );
  }
  return (
    <span data-kit="Text" data-variant={variant} style={style}>
      {text}
    </span>
  );
}
