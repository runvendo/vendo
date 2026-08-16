/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 */
import type { PropsWithChildren } from "react";
import { font, hairline, t, transitionFor, type KitStyled } from "../tokens.js";

export interface ButtonProps extends KitStyled {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Bound host-tool action (renderer-supplied). */
  onClick?: () => void;
  type?: "button" | "submit";
}

export function Button({ label, variant = "primary", disabled = false, onClick, type = "button", style, children }: PropsWithChildren<ButtonProps>) {
  const primary = variant === "primary";
  const danger = variant === "danger";
  const background = primary ? t.accent : danger ? t.danger : t.surface;
  const color = primary || danger ? t.accentText : t.text;
  return (
    <button
      type={type}
      data-kit="Button"
      data-variant={variant}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onClick?.();
      }}
      style={{
        ...font,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--vendo-density-inline-gap, 7px)",
        minHeight: "var(--vendo-density-control-height, 38px)",
        border: primary || danger ? `${t.borderWidth} solid transparent` : hairline,
        borderRadius: t.radiusSmall,
        color,
        background,
        // The one lift in the Kit: the page's filled action. Every other surface
        // is flat and states its edge with the hairline instead.
        boxShadow: primary || danger ? t.shadowSmall : "none",
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: t.weightEmphasis,
        lineHeight: t.lineHeightHeading,
        opacity: disabled ? 0.55 : 1,
        padding: "var(--vendo-density-control-padding, 9px 12px)",
        transition: transitionFor("background-color", "border-color", "box-shadow", "opacity"),
        ...style,
      }}
    >
      {label ?? children}
    </button>
  );
}
