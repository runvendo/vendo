/** Stat — a KPI/metric summary with semantic formatting (W2 §The Kit). */
import { applyFormat, type ValueFormat } from "../format.js";
import { amountColor, font, t } from "../tokens.js";

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
  // A negative sum of money is a loss whether or not the writer said so.
  const resolvedTone = tone === "default" && amountColor(value, format) ? "danger" : tone;
  const emphasis = resolvedTone === "accent" ? t.accent : resolvedTone === "danger" ? t.danger : t.text;
  // The rail is DECORATION, so an untoned tile draws it as a hairline in the
  // theme's border colour — the same default `Card` already uses for its own
  // border. Painting it `t.text` made a 3px near-black bar the loudest thing on
  // an otherwise neutral screen, so it read as an accent colour the host never
  // chose, while the host's real accent went unused.
  const rail = resolvedTone === "default" ? t.border : emphasis;
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
        display: "flex",
        flexDirection: "column",
        gap: "var(--vendo-density-field-gap, 6px)",
        minWidth: 0,
        borderLeft: `3px solid ${rail}`,
        borderRadius: t.radiusSmall,
        background: `color-mix(in srgb, ${t.surface} 90%, ${t.background})`,
        padding: "var(--vendo-density-stat-padding, 12px 14px)",
      }}
    >
      <span style={{ color: t.muted, fontSize: "0.82em", fontWeight: 650 }}>{label}</span>
      <strong
        {...(empty ? { "data-empty": "", title: "No data yet" } : overflow ? { title: formatted } : {})}
        style={{
          color: empty ? t.muted : emphasis,
          fontFamily: t.headingFamily,
          fontSize: "calc(var(--vendo-font-size, 15px) * 1.65)",
          fontWeight: 700,
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
