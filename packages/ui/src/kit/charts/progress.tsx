/** Progress — a themed progress bar; ratio or value/max (W2 §The Kit). */
import { isRenderableNumber } from "../format.js";
import { useFieldValue } from "../row.js";
import { font, resolveTone, t, toneColor, type KitTone } from "../tokens.js";

export interface ProgressProps {
  /** A ratio (0..1) unless `max` is given, then a raw value. */
  value?: number;
  /** When set, `value/max` is the ratio. */
  max?: number;
  label?: string;
  /** Show the percentage text. */
  showValue?: boolean;
  tone?: KitTone;
  /** Inside a cell slot: the row field this value comes from. */
  field?: string;
}

export function Progress({ value, max, label, showValue = false, tone, field }: ProgressProps) {
  const own = useFieldValue(field, value);
  if (!isRenderableNumber(own) || (max !== undefined && !isRenderableNumber(max))) {
    return (
      <div data-kit="Progress" style={{ ...font, color: t.muted }}>
        —
      </div>
    );
  }
  const ratio = max !== undefined && max !== 0 ? own / max : own;
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
        // The ratio is `ChartFrame`'s intrinsic-width trick (charts/sanitize.tsx)
        // at a meter's proportion: an unlabelled bar has no content, so a parent
        // that sizes to what is inside it (the Kit's `Row`) resolved this
        // `width: 100%` to zero and the bar vanished. A parent with a real width
        // still wins.
        style={{ width: "100%", aspectRatio: "16 / 1", height: 8, borderRadius: 999, background: `color-mix(in srgb, ${t.muted} 18%, ${t.surface})`, overflow: "hidden" }}
      >
        <div
          style={{
            width: pct,
            height: "100%",
            borderRadius: 999,
            background: toneColor(resolveTone(tone, "accent")),
            transition: `width ${t.motionDuration} ${t.motionEasing}`,
          }}
        />
      </div>
    </div>
  );
}
