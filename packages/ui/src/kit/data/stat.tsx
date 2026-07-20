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

export function Stat({ label, value, format = "text", trend, tone = "default" }: StatProps) {
  const emphasis = tone === "accent" ? t.accent : tone === "danger" ? t.danger : t.text;
  const formatted = applyFormat(value, format);
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
        style={{
          color: emphasis,
          fontFamily: t.headingFamily,
          fontSize: "calc(var(--vendo-font-size, 15px) * 1.65)",
          fontWeight: 700,
          letterSpacing: "-0.025em",
          lineHeight: 1.12,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatted ?? "—"}
      </strong>
      {trend ? (
        <span style={{ color: t.muted, fontSize: "0.8em", lineHeight: 1.35 }}>{trend}</span>
      ) : null}
    </article>
  );
}
