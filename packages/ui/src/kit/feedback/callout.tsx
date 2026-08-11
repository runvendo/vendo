/**
 * Callout — a toned info/accent/success/warning/danger notice (W2 §The Kit).
 * Distinct from Disclaimer: Callout highlights real information; Disclaimer is
 * the honesty arm for when no tool backs the ask.
 */
import type { PropsWithChildren } from "react";
import { font, t } from "../tokens.js";

export type CalloutTone = "info" | "accent" | "success" | "warning" | "danger";

const TONE: Record<CalloutTone, { accent: string; icon: string }> = {
  info: { accent: t.accent, icon: "ⓘ" },
  // "accent" is the tone the sibling vocabularies teach (Badge/EnumBadge/
  // Stat/Progress), so generated code reaches for it constantly — re-gate
  // 2026-07-26 arm C crashed on it four times. First-class, brand-accented.
  accent: { accent: t.accent, icon: "●" },
  success: { accent: "#1e7f53", icon: "✓" },
  warning: { accent: "#b8860b", icon: "▲" },
  danger: { accent: t.danger, icon: "✕" },
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: string;
}

export function Callout({ tone = "info", title, children }: PropsWithChildren<CalloutProps>) {
  // Unknown tone values fall back to info instead of crashing: generated
  // island code passes arbitrary strings, and a themed notice with the wrong
  // color always beats "Node could not render: Cannot destructure 'accent'".
  // Object.hasOwn, not a bare index: an unvalidated tone like "constructor"
  // or "toString" would otherwise pick up Object.prototype members instead
  // of falling back (review 2026-07-26).
  const { accent, icon } = Object.hasOwn(TONE, tone) ? TONE[tone] : TONE.info;
  return (
    <div
      data-kit="Callout"
      data-tone={tone}
      role="status"
      style={{
        ...font,
        display: "flex",
        gap: "var(--vendo-density-inline-gap, 10px)",
        alignItems: "flex-start",
        borderLeft: `3px solid ${accent}`,
        border: `1px solid color-mix(in srgb, ${accent} 25%, ${t.border})`,
        borderLeftWidth: 3,
        borderRadius: t.radiusMedium,
        background: `color-mix(in srgb, ${accent} 7%, ${t.surface})`,
        padding: "var(--vendo-density-card-padding, 12px 14px)",
      }}
    >
      <span aria-hidden="true" style={{ color: accent, fontWeight: 700, lineHeight: 1.4 }}>
        {icon}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {title ? <span style={{ fontWeight: 650, letterSpacing: "-0.01em" }}>{title}</span> : null}
        <span style={{ color: t.muted, fontSize: "0.92em", lineHeight: 1.45 }}>{children}</span>
      </div>
    </div>
  );
}
