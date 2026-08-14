/**
 * Callout — a toned info/accent/success/warning/danger notice (W2 §The Kit).
 * Distinct from Disclaimer: Callout highlights real information; Disclaimer is
 * the honesty arm for when no tool backs the ask.
 */
import type { PropsWithChildren } from "react";
import { font, resolveTone, t, toneColor, type KitTone } from "../tokens.js";

/** The shared vocabulary plus "info", which a Callout keeps as its own spelling:
 *  elsewhere it is the legacy name for neutral, but a notice has ALWAYS been
 *  brand-accented with the ⓘ, and it is still the default. */
export type CalloutTone = KitTone | "info";

const TONE: Record<CalloutTone, { accent: string; icon: string }> = {
  info: { accent: t.accent, icon: "ⓘ" },
  neutral: { accent: toneColor("neutral"), icon: "ⓘ" },
  // "accent" is the tone the sibling vocabularies teach (Badge/EnumBadge/
  // Stat/Progress), so generated code reaches for it constantly — re-gate
  // 2026-07-26 arm C crashed on it four times. First-class, brand-accented.
  accent: { accent: t.accent, icon: "●" },
  success: { accent: toneColor("success"), icon: "✓" },
  warning: { accent: toneColor("warning"), icon: "▲" },
  danger: { accent: toneColor("danger"), icon: "✕" },
};

export interface CalloutProps {
  tone?: CalloutTone;
  title?: string;
}

export function Callout({ tone = "info", title, children }: PropsWithChildren<CalloutProps>) {
  // "info" is read HERE, before the shared resolver would flatten it to neutral:
  // it is this component's default and has always been the accented ⓘ. Every
  // other word goes through the ONE resolver, so "default" lands on neutral like
  // it does on a Card and an unvalidated string ("constructor") falls back
  // instead of picking up an Object.prototype member (review 2026-07-26).
  const resolved: CalloutTone = tone === "info" ? "info" : resolveTone(tone);
  const { accent, icon } = TONE[resolved];
  return (
    <div
      data-kit="Callout"
      data-tone={resolved}
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
