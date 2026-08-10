/** Progress — a themed progress bar; ratio or value/max (W2 §The Kit). */
import { isRenderableNumber } from "../format.js";
import { font, t } from "../tokens.js";

export interface ProgressProps {
  /** A ratio (0..1) unless `max` is given, then a raw value. */
  value: number;
  /** When set, `value/max` is the ratio. */
  max?: number;
  label?: string;
  /** Show the percentage text. */
  showValue?: boolean;
  tone?: "accent" | "success" | "danger";
}

const TONE_FILL: Record<NonNullable<ProgressProps["tone"]>, string> = {
  accent: t.accent,
  success: "#1e7f53",
  danger: t.danger,
};

export function Progress({ value, max, label, showValue = false, tone = "accent" }: ProgressProps) {
  if (!isRenderableNumber(value) || (max !== undefined && !isRenderableNumber(max))) {
    return (
      <div data-kit="Progress" style={{ ...font, color: t.muted }}>
        —
      </div>
    );
  }
  const ratio = max !== undefined && max !== 0 ? value / max : value;
  const clamped = Math.max(0, Math.min(1, ratio));
  const pct = `${Math.round(clamped * 100)}%`;
  const over = ratio > 1;
  // The two readings a clamped track cannot draw: an empty meter looks like a missing one,
  // and an over-capacity value is pixel-identical to exactly full — so both say it in words.
  const readout = clamped === 0 ? "None" : over ? `${Math.round(ratio * 100)}%` : showValue ? pct : null;
  return (
    <div data-kit="Progress" style={{ ...font, display: "flex", flexDirection: "column", gap: 4 }}>
      {(label || readout) && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85em" }}>
          {label ? <span style={{ color: t.muted }}>{label}</span> : <span />}
          {readout ? <span style={{ color: clamped === 0 ? t.muted : undefined, fontVariantNumeric: "tabular-nums" }}>{readout}</span> : null}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ width: "100%", height: 8, borderRadius: 999, background: `color-mix(in srgb, ${t.muted} 18%, ${t.surface})`, overflow: "hidden" }}
      >
        {clamped > 0 && (
          <div
            style={{
              width: pct,
              height: "100%",
              borderRadius: 999,
              background: over ? t.danger : TONE_FILL[tone],
              transition: `width ${t.motionDuration} ${t.motionEasing}`,
            }}
          />
        )}
      </div>
    </div>
  );
}
