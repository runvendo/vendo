/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 */
import type { PropsWithChildren } from "react";
import { font, t } from "../tokens.js";

export interface ButtonProps {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Bound host-tool action (renderer-supplied). */
  onClick?: () => void;
  type?: "button" | "submit";
}

export function Button({ label, variant = "primary", disabled = false, onClick, type = "button", children }: PropsWithChildren<ButtonProps>) {
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
        border: primary || danger ? "1px solid transparent" : `1px solid ${t.border}`,
        borderRadius: t.radiusSmall,
        color,
        background,
        boxShadow: primary || danger
          ? `0 2px 8px color-mix(in srgb, ${t.text} 14%, transparent)`
          : `0 1px 2px color-mix(in srgb, ${t.text} 7%, transparent)`,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 650,
        lineHeight: 1.2,
        opacity: disabled ? 0.55 : 1,
        padding: "var(--vendo-density-control-padding, 9px 12px)",
        transition: `background-color ${t.motionDuration} ${t.motionEasing}, opacity ${t.motionDuration} ${t.motionEasing}`,
      }}
    >
      {label ?? children}
    </button>
  );
}
