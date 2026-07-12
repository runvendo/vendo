import { createPrewiredImpl } from "../../impl-helpers/create-impl.js";
import { resolveCenterValue } from "./center-value.js";
import { donutSchema } from "./descriptor.js";

const MUTED = "var(--vendo-fg-muted, rgba(0,0,0,0.55))";
/** Brand-accent opacity ramp — token-driven, on-brand for any host. */
const RAMP_OPACITY = [1, 0.72, 0.5, 0.34, 0.22, 0.14, 0.55, 0.4, 0.28, 0.18];

function arcPath(cx: number, cy: number, r: number, start: number, end: number): string {
  // start/end in turns from 12 o'clock, clockwise.
  const a0 = (start - 0.25) * 2 * Math.PI;
  const a1 = (end - 0.25) * 2 * Math.PI;
  const large = end - start > 0.5 ? 1 : 0;
  return `M ${cx + r * Math.cos(a0)} ${cy + r * Math.sin(a0)} A ${r} ${r} 0 ${large} 1 ${cx + r * Math.cos(a1)} ${cy + r * Math.sin(a1)}`;
}

export const Donut = createPrewiredImpl(donutSchema, (p) => {
  const size = p.size ?? 180;
  const total = p.slices.reduce((s, x) => s + x.value, 0);
  // The center money-total is derived from the legend values so it can never
  // disagree with them (a model-authored centerValue can be independently
  // wrong). Non-currency centers pass through unchanged. See center-value.ts.
  const centerValue = resolveCenterValue(p.slices, p.centerValue);
  const stroke = size * 0.14;
  const r = size / 2 - stroke / 2;
  const gap = p.slices.length > 1 ? 0.008 : 0; // small breathing gap between arcs

  let cursor = 0;
  const arcs = p.slices.map((slice, i) => {
    const frac = slice.value / total;
    // An SVG arc whose endpoints coincide renders NOTHING per spec — a slice
    // covering (nearly) the full turn must draw as a circle instead.
    const full = frac >= 0.999;
    const start = cursor + gap / 2;
    const end = cursor + Math.max(frac - gap / 2, 0.001);
    cursor += frac;
    return { slice, i, full, d: full ? "" : arcPath(size / 2, size / 2, r, start, end) };
  });

  return (
    <div data-donut style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          {arcs.map(({ slice, i, full, d }) =>
            full ? (
              <circle
                key={`${slice.label}-${i}`}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={slice.color ?? "var(--vendo-accent, #111)"}
                strokeOpacity={slice.color ? 1 : RAMP_OPACITY[i % RAMP_OPACITY.length]}
                strokeWidth={stroke}
              />
            ) : (
              <path
                key={`${slice.label}-${i}`}
                d={d}
                fill="none"
                stroke={slice.color ?? "var(--vendo-accent, #111)"}
                strokeOpacity={slice.color ? 1 : RAMP_OPACITY[i % RAMP_OPACITY.length]}
                strokeWidth={stroke}
                strokeLinecap="butt"
              />
            ),
          )}
        </svg>
        {(p.centerLabel || centerValue) && (
          <div
            style={{
              position: "absolute", inset: 0, display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center", pointerEvents: "none",
            }}
          >
            {p.centerLabel ? (
              <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", color: MUTED }}>
                {p.centerLabel}
              </span>
            ) : null}
            {centerValue ? (
              <span style={{ fontSize: size / 9, fontWeight: 650, fontVariantNumeric: "tabular-nums", color: "var(--vendo-fg, inherit)" }}>
                {centerValue}
              </span>
            ) : null}
          </div>
        )}
      </div>
      {p.legend !== false && (
        <div data-donut-legend style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 140, flex: 1 }}>
          {p.slices.map((slice, i) => (
            <div key={`${slice.label}-${i}`} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                aria-hidden
                style={{
                  width: 8, height: 8, borderRadius: 999, flex: "none",
                  background: slice.color ?? "var(--vendo-accent, #111)",
                  opacity: slice.color ? 1 : RAMP_OPACITY[i % RAMP_OPACITY.length],
                }}
              />
              <span style={{ fontSize: 13, color: MUTED, flex: 1 }}>{slice.label}</span>
              <span style={{ fontSize: 13, fontVariantNumeric: "tabular-nums", color: "var(--vendo-fg, inherit)" }}>
                {slice.display ?? String(slice.value)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
