/** EmptyState — the designed nothing-here, with the action that fixes it
 *  nested inside (W2 §The Kit). Same dashed frame the charts' empty state uses,
 *  so an empty region reads as intentional rather than broken. */
import type { PropsWithChildren } from "react";
import { Icon } from "../icon.js";
import { font, t } from "../tokens.js";

export interface EmptyStateProps {
  /** A lucide icon name in kebab-case; an unknown one draws nothing. */
  icon?: string;
  /** The headline. */
  title: string;
  /** One line of why it is empty, or what to do about it. */
  description?: string;
}

export function EmptyState({ icon, title, description, children }: PropsWithChildren<EmptyStateProps>) {
  return (
    <div
      data-kit="EmptyState"
      style={{
        ...font,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "var(--vendo-density-field-gap, 6px)",
        border: `${t.borderWidth} dashed ${t.border}`,
        borderRadius: t.radiusMedium,
        background: `color-mix(in srgb, ${t.background} 40%, transparent)`,
        padding: "calc(var(--vendo-font-size, 15px) * 1.8) var(--vendo-density-card-padding, 16px)",
        textAlign: "center",
      }}
    >
      {icon ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 38,
            height: 38,
            marginBottom: 2,
            borderRadius: "50%",
            background: `color-mix(in srgb, ${t.accent} 10%, ${t.surface})`,
            color: t.accent,
          }}
        >
          <Icon name={icon} size={19} />
        </span>
      ) : null}
      <span style={{ fontFamily: t.headingFamily, fontWeight: t.weightEmphasis, letterSpacing: "-0.015em" }}>{title}</span>
      {description ? (
        <span style={{ color: t.muted, fontSize: "0.9em", lineHeight: 1.45, maxWidth: "44ch" }}>{description}</span>
      ) : null}
      {children}
    </div>
  );
}
