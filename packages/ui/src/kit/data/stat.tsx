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

/** The words a zero metric leads with. A bare "0" or "$0.00" is the number the
 *  screen would print if it had failed to read the data at all, so the tile
 *  states the fact and keeps the exact figure beneath it — nothing is hidden,
 *  and the person does not have to interpret a digit. */
const ZERO_WORDS = "Nothing yet";

/** A metric whose value is numerically zero — "0", "0.00", "$0.00", "0%". Prose
 *  ("No sessions") parses as NaN and is already words, so it is left alone. */
function isZeroValue(value: number | string): boolean {
  const text = String(value).trim();
  return text !== "" && Number(text) === 0;
}

export function Stat({ label, value, format = "text", trend, tone = "default" }: StatProps) {
  const emphasis = tone === "accent" ? t.accent : tone === "danger" ? t.danger : t.text;
  const formatted = applyFormat(value, format);
  const empty = formatted === null;
  const zero = !empty && isZeroValue(value);
  const overflow = !empty && formatted.length > STAT_VALUE_MAX_CHARS;
  const display = empty
    ? "—"
    : zero
      ? ZERO_WORDS
      : overflow
        ? `${formatted.slice(0, STAT_VALUE_MAX_CHARS - 1).trimEnd()}…`
        : formatted;
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
      {zero ? (
        <span style={{ color: t.muted, fontSize: "0.85em", fontVariantNumeric: "tabular-nums" }}>{formatted}</span>
      ) : null}
      {trend ? (
        <span style={{ color: t.muted, fontSize: "0.8em", lineHeight: 1.35 }}>{trend}</span>
      ) : null}
    </article>
  );
}
