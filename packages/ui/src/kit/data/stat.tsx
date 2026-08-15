/** Stat — a KPI/metric summary with semantic formatting (W2 §The Kit). */
import type { ReactNode } from "react";
import { applyFormat, type ValueFormat } from "../format.js";
import { densityVars, font, hairline, microLabel, numeric, resolveTone, t, toneColor, type KitDensity, type KitTone } from "../tokens.js";

export interface StatProps {
  /** Metric name. */
  label: string;
  /** Raw value; formatted by `format` (money takes major units, never cents). */
  value: number | string;
  /** Value-tier format. */
  format?: ValueFormat;
  /** A trend / delta caption, e.g. "+12% MoM". */
  trend?: string;
  /** Emphasis. "default" is the older spelling of "neutral". */
  tone?: KitTone | "default";
  /** Spacing scale for this tile. */
  density?: KitDensity;
  /** Kit value components rendered under the number — a Sparkline, an EnumBadge. */
  children?: ReactNode;
}

/** A KPI value is a number or a short phrase, never prose: past this length
 *  the tile clips and overlaps its neighbors (the fresh-install screenshots),
 *  so longer text renders truncated with the full text in the tooltip. */
const STAT_VALUE_MAX_CHARS = 40;

export function Stat({ label, value, format = "text", trend, tone, density, children }: StatProps) {
  const resolvedTone = resolveTone(tone, "neutral");
  const emphasis = toneColor(resolvedTone);
  const formatted = applyFormat(value, format);
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
      }}
    >
      <span style={microLabel}>{label}</span>
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
