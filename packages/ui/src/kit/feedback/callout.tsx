/**
 * Callout — a toned info/accent/success/warning/danger notice (W2 §The Kit).
 * Distinct from Disclaimer: Callout highlights real information; Disclaimer is
 * the honesty arm for when no tool backs the ask.
 */
import type { PropsWithChildren } from "react";
import { font, resolveTone, t, toneColor, type KitStyled, type KitTone } from "../tokens.js";

/** The shared vocabulary, with "info" read as a Callout has always read it: a
 *  notice is brand-accented with the ⓘ, and it is still this component's default.
 *  Elsewhere `info` is the status colour of a state in progress. */
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

export interface CalloutProps extends KitStyled {
  tone?: CalloutTone;
  title?: string;
}

export function Callout({ tone = "info", title, style, children }: PropsWithChildren<CalloutProps>) {
  // "info" is read HERE, before the shared resolver would give it the status
  // colour: it is this component's default and has always been the accented ⓘ.
  // Every other word goes through the ONE resolver, so "default" lands on neutral like
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
        border: `${t.borderWidth} solid color-mix(in srgb, ${accent} 25%, ${t.border})`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: t.radiusMedium,
        background: `color-mix(in srgb, ${accent} 7%, ${t.surface})`,
        padding: "var(--vendo-density-card-padding, 12px 14px)",
        ...style,
      }}
    >
      <span aria-hidden="true" style={{ color: accent, fontWeight: t.weightEmphasis, lineHeight: t.lineHeight }}>
        {icon}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {title ? <span style={{ fontWeight: t.weightEmphasis }}>{title}</span> : null}
        <span style={{ color: t.muted, fontSize: "0.92em" }}>{children}</span>
      </div>
    </div>
  );
}
