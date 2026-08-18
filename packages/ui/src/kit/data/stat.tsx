/** Stat — a KPI/metric summary tile (W2 §The Kit). */
import type { ReactNode } from "react";
import { applyFormat } from "../format.js";
import { densityVars, font, hairline, microLabel, numeric, resolveTone, t, toneColor, type KitDensity, type KitStyled, type KitTone } from "../tokens.js";

export interface StatProps extends KitStyled {
  /** Metric name. */
  label: string;
  /** The figure, DISPLAYED AS GIVEN — the screen formats it (`toLocaleString`)
   *  and the tile does the typography. */
  value: number | string;
  /** A unit written after the value — "ms", "min", "h". */
  unit?: string;
  /** A trend / delta caption, e.g. "+12% MoM". */
  trend?: string;
  /** Emphasis. "default" is the older spelling of "neutral". */
  tone?: KitTone | "default";
  /** Spacing scale for this tile. */
  density?: KitDensity;
  /** A Kit mark beside the metric name. */
  icon?: ReactNode;
  /** Kit value components rendered under the number — a Sparkline, an EnumBadge. */
  children?: ReactNode;
}

/** A KPI value is a number or a short phrase, never prose: past this length
 *  the tile clips and overlaps its neighbors (the fresh-install screenshots),
 *  so longer text renders truncated with the full text in the tooltip. */
const STAT_VALUE_MAX_CHARS = 40;

export function Stat({ label, value, unit, trend, tone, density, icon, style, children }: StatProps) {
  const resolvedTone = resolveTone(tone, "neutral");
  const emphasis = toneColor(resolvedTone);
  // The value is text the screen already formatted (`total.toLocaleString(…)`),
  // so the tile prints it. The coercion is still the total one: an absent or
  // blank value answers `null`, which is what paints the em dash below instead
  // of the word "undefined" in 27px type.
  const shown = applyFormat(value, "text");
  const formatted = shown !== null && unit !== undefined ? `${shown} ${unit}` : shown;
  const empty = formatted === null;
  const overflow = !empty && formatted.length > STAT_VALUE_MAX_CHARS;
  const display = empty
    ? "—"
    : overflow
      ? `${formatted.slice(0, STAT_VALUE_MAX_CHARS - 1).trimEnd()}…`
      : formatted;
  return (
    <article
      data-kit="Stat"
      data-tone={resolvedTone}
      aria-label={label}
      style={{
        ...font,
        ...densityVars(density),
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
        minWidth: 0,
        // The tone rule only paints when there IS a tone: a neutral tile's
        // `emphasis` is the foreground itself, and a near-black 3px bar on every
        // resting tile is the opposite of quiet.
        border: hairline,
        ...(resolvedTone === "neutral" ? {} : { borderLeft: `3px solid ${emphasis}` }),
        borderRadius: t.radiusSmall,
        background: t.surface,
        padding: "var(--vendo-density-stat-padding, 12px 14px)",
        ...style,
      }}
    >
      {/* A row whether or not a glyph came: with one child it lays out exactly
          as the plain label did, so the slot costs no branch. */}
      <span style={{ ...microLabel, display: "flex", alignItems: "center", gap: "var(--vendo-density-field-gap, 6px)" }}>
        {icon}
        {label}
      </span>
      <strong
        {...(empty ? { "data-empty": "", title: "No data yet" } : overflow ? { title: formatted } : {})}
        style={{
          ...numeric,
          color: empty ? t.muted : emphasis,
          fontFamily: t.headingFamily,
          fontSize: "calc(var(--vendo-font-size, 15px) * 1.65)",
          fontWeight: t.weightEmphasis,
          letterSpacing: "-0.025em",
          lineHeight: 1.12,
          // A money figure has no break opportunity of its own, so a tile
          // narrower than its number cut it off mid-number ("$1,113.1").
          overflowWrap: "anywhere",
        }}
      >
        {display}
      </strong>
      {trend ? (
        <span style={{ ...numeric, color: t.muted, fontSize: "0.8em" }}>{trend}</span>
      ) : null}
      {children}
    </article>
  );
}
