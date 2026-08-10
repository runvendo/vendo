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
  // Was a hardcoded #1e7f53, which is a second green beside the brand's own on a
  // green host and an unexplained green on a host with no green at all.
  success: `color-mix(in srgb, ${t.accent} 82%, ${t.text})`,
  danger: t.danger,
};

/** An untoned bar is decoration, so it fills in the theme's text tone. `tone`
 *  spends the accent or the danger colour only when the writer means it. */
const NEUTRAL_FILL = `color-mix(in srgb, ${t.text} 62%, ${t.surface})`;

export function Progress({ value, max, label, showValue = false, tone }: ProgressProps) {
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
  return (
    <div data-kit="Progress" style={{ ...font, display: "flex", flexDirection: "column", gap: 4 }}>
      {(label || showValue) && (
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.85em" }}>
          {label ? <span style={{ color: t.muted }}>{label}</span> : <span />}
          {showValue ? <span style={{ fontVariantNumeric: "tabular-nums" }}>{pct}</span> : null}
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        style={{ width: "100%", height: 8, borderRadius: 999, background: `color-mix(in srgb, ${t.muted} 18%, ${t.surface})`, overflow: "hidden" }}
      >
        <div
          style={{
            width: pct,
            height: "100%",
            borderRadius: 999,
            background: tone ? TONE_FILL[tone] : NEUTRAL_FILL,
            transition: `width ${t.motionDuration} ${t.motionEasing}`,
          }}
        />
      </div>
    </div>
  );
}
