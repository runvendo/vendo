/** Stat — a KPI/metric summary with semantic formatting (W2 §The Kit). */
import { applyFormat, type ValueFormat } from "../format.js";
import { font, t } from "../tokens.js";

export interface StatProps {
  /** Metric name. */
  label: string;
  /** Raw value; formatted by `format` (money takes cents). */
  value: number | string;
  /** Value-tier format. */
  format?: ValueFormat;
  /** A trend / delta caption, e.g. "+12% MoM". */
  trend?: string;
  tone?: "default" | "accent" | "danger";
}

/** A KPI value is a number or a short phrase, never prose: past this length
 *  the tile clips and overlaps its neighbors (the fresh-install screenshots),
 *  so longer text renders truncated with the full text in the tooltip. */
const STAT_VALUE_MAX_CHARS = 40;

export function Stat({ label, value, format = "text", trend, tone = "default" }: StatProps) {
  const emphasis = tone === "accent" ? t.accent : tone === "danger" ? t.danger : t.text;
  const formatted = applyFormat(value, format);
  const empty = formatted === null;
  // A hole in the data, or an exact zero count, is said in words at body size —
  // at the hero size a glyph for "nothing" becomes the largest text on the screen.
  // Money and percent keep their numbers: $0.00 and 0% are real values.
  const words = empty ? "No data yet" : format === "number" && value === 0 ? "None" : null;
  const overflow = !empty && formatted.length > STAT_VALUE_MAX_CHARS;
  const display =
    words ?? (overflow ? `${formatted.slice(0, STAT_VALUE_MAX_CHARS - 1).trimEnd()}…` : formatted);
  return (
    <article
      data-kit="Stat"
      data-tone={tone}
      aria-label={label}
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
        minWidth: 0,
        borderLeft: `3px solid ${emphasis}`,
        borderRadius: t.radiusSmall,
        background: `color-mix(in srgb, ${t.surface} 90%, ${t.background})`,
        padding: "var(--vendo-density-stat-padding, 12px 14px)",
      }}
    >
      <span style={{ color: t.muted, fontSize: "0.82em", fontWeight: 650 }}>{label}</span>
      <strong
        {...(empty ? { "data-empty": "" } : overflow ? { title: formatted } : {})}
        style={{
          color: words ? t.muted : emphasis,
          fontFamily: t.headingFamily,
          fontSize: words ? "1em" : "calc(var(--vendo-font-size, 15px) * 1.65)",
          fontWeight: words ? 500 : 700,
          letterSpacing: "-0.025em",
          lineHeight: 1.12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {display}
      </strong>
      {trend ? (
        <span style={{ color: t.muted, fontSize: "0.8em", lineHeight: 1.35 }}>{trend}</span>
      ) : null}
    </article>
  );
}
