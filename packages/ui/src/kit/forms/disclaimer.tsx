/**
 * Disclaimer — first-class (W2 §The Kit + spec law 1). When no tool backs the
 * ask, the honest, legal move is to say so — not to invent data. A styled,
 * deliberate notice, never an error or an empty div.
 */
import { font, t } from "../tokens.js";

export interface DisclaimerProps {
  /** Why the ask can't be fulfilled with real data. */
  reason: string;
  /** Optional heading; defaults to a neutral lead-in. */
  title?: string;
}

export function Disclaimer({ reason, title = "Not available" }: DisclaimerProps) {
  return (
    <div
      data-kit="Disclaimer"
      role="note"
      style={{
        ...font,
        display: "flex",
        gap: "var(--vendo-density-inline-gap, 10px)",
        alignItems: "flex-start",
        border: `1px solid color-mix(in srgb, ${t.muted} 28%, ${t.border})`,
        borderRadius: t.radiusMedium,
        background: `color-mix(in srgb, ${t.muted} 7%, ${t.surface})`,
        padding: "var(--vendo-density-card-padding, 14px 16px)",
      }}
    >
      <span aria-hidden="true" style={{ fontSize: "1.1em", lineHeight: 1.3, color: t.muted }}>
        ⓘ
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <span style={{ fontWeight: 650, letterSpacing: "-0.01em" }}>{title}</span>
        <span style={{ color: t.muted, fontSize: "0.92em", lineHeight: 1.45 }}>{reason}</span>
      </div>
    </div>
  );
}
