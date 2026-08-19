/**
 * The text tier — themed prose, the enum pill, and the muted placeholder every
 * container shows for a value it cannot print (W2 §The Kit).
 *
 * A screen formats its own figures with `Intl` now, so nothing here formats:
 * what is left is DISPLAY — a face, a tone, and the one total coercion that
 * turns an unrenderable value into a designed dash rather than bad text.
 */
import { isValidElement, type CSSProperties, type PropsWithChildren, type ReactNode } from "react";
import { applyFormat } from "./format.js";
import { font, microLabel, mono, resolveTone, t, toneColor, toneStyle, type KitStyled, type KitTone } from "./tokens.js";

const PLACEHOLDER = "—";

function Placeholder({ style }: KitStyled): ReactNode {
  return (
    <span data-kit="Placeholder" style={{ color: t.muted, ...style }} aria-hidden="true">
      {PLACEHOLDER}
    </span>
  );
}

/** A tone's paint, or nothing at all — an absent (or neutral) tone leaves the
 *  component's own color exactly as it was. The catalog teaches "the figure that
 *  is bad news is `danger`", and a figure is painted by the `Text` around it, so
 *  that tone has to land here. */
function tonePaint(tone: KitTone | undefined): CSSProperties {
  const resolved = resolveTone(tone);
  return resolved === "neutral" ? {} : { color: toneColor(resolved) };
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
}

/** A record entry the model authored, or nothing. `Object.hasOwn`, not a bare
 *  index: an enum value of "toString" would otherwise pick up
 *  `Object.prototype`'s member — a function handed to React as a child. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A status pill for enum fields — humanized label, tone-mapped color. */
export function EnumBadge({ value, labels, tones, tone, style }: EnumBadgeProps) {
  const key = applyFormat(value, "text");
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
  variant?: "body" | "heading" | "caption" | "label" | "code";
  /** Paints the text — a `danger` figure is how an overdue amount reads red. */
  tone?: KitTone;
}

/** Themed text. Heading renders an <h3>; others render a <span>. */
export function Text({ text, variant = "body", tone, style, children }: PropsWithChildren<TextProps>) {
  // `text` holds ANYTHING the expression behind it evaluated to: a plain object
  // as a React child throws ("Objects are not valid as a React child") and a
  // boolean renders as literally NOTHING, which is how `active: false` came out
  // blank. An element passes through as itself; every other value goes through
  // the total text coercion — an object never reaching it, since it would spell
  // the object "[object Object]".
  //
  // ABSENT is not the same as unrenderable, and only Text can tell them apart:
  // a binding whose query has not answered yet resolves to undefined, and a
  // placeholder dash there reads as "no data" for data that is still on its
  // way. Nothing renders as nothing; the dash is for a value that arrived and
  // could not be shown.
  const written = isValidElement(text)
    ? text
    : text === undefined || text === null || text === ""
      ? null
      : (applyFormat(typeof text === "object" ? null : text, "text") ?? <Placeholder />);
  // CHILDREN are the sentence form, and the whole point of them is that a
  // formatted figure sits INSIDE the sentence: `<Text variant="caption">Overdue:
  // {(cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })}
  // across {n} invoices</Text>`. With `text` the only way in, a phrase and its
  // figures would have to be concatenated into one string before they got here,
  // and nothing in it could be composed or painted on its own. `text` still wins
  // where both are given: it is the prop every stored screen carries.
  const content = written ?? children;
  const rootStyle: CSSProperties = {
    ...font,
    // `label` IS the micro-label — the word over a figure, not prose. `caption`
    // stays sentence-case: it carries model-authored sentences, and uppercasing
    // a sentence costs more legibility than the rhythm buys.
    ...(variant === "label" ? microLabel : {}),
    ...(variant === "caption" ? { color: t.muted, fontSize: "var(--vendo-font-size-caption, 12.5px)" } : {}),
    // `code` is the IDENTIFIER role — a sha, a branch, an id. Same text, the
    // host's mono face, so it reads as a value to compare rather than prose.
    ...(variant === "code" ? mono : {}),
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
