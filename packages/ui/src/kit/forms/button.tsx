/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 */
import { useState, type PropsWithChildren } from "react";
import { font, t } from "../tokens.js";

export interface ButtonProps {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** Bound host-tool action (renderer-supplied). */
  onClick?: () => void;
  type?: "button" | "submit";
  /** The question the danger confirmation asks. */
  confirm?: string;
}

export function Button({ label, variant = "primary", disabled = false, onClick, type = "button", confirm, children }: PropsWithChildren<ButtonProps>) {
  const [asking, setAsking] = useState(false);
  const danger = variant === "danger";
  if (!danger || disabled) {
    return <Pressable variant={variant} disabled={disabled} type={type} onPress={() => onClick?.()}>{label ?? children}</Pressable>;
  }
  if (!asking) {
    // A destructive press can only ever open the question — forced to
    // type="button" so a submit-typed danger button inside a Form doesn't
    // submit it on the way to the dialog (Form owns preventDefault).
    return <Pressable variant="danger" type="button" onPress={() => setAsking(true)}>{label ?? children}</Pressable>;
  }
  const question = confirm ?? `${label ?? "This"} — this can't be undone.`;
  return (
    // The way out comes first and the destructive control last: that order is
    // what makes "the last control in the dialog" the one that destroys.
    <div
      role="dialog"
      aria-label={question}
      style={{
        ...font,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "var(--vendo-density-inline-gap, 7px)",
        border: `1px solid ${t.border}`,
        borderRadius: t.radiusMedium,
        background: t.surface,
        padding: "var(--vendo-density-card-padding, 12px 14px)",
      }}
    >
      <span style={{ color: t.muted, flex: "1 1 100%" }}>{question}</span>
      <Pressable variant="secondary" type="button" onPress={() => setAsking(false)}>Keep it</Pressable>
      <Pressable variant="danger" type={type} onPress={() => { setAsking(false); onClick?.(); }}>{label ?? children}</Pressable>
    </div>
  );
}

function Pressable({ variant, disabled = false, type, onPress, children }: PropsWithChildren<{ variant: NonNullable<ButtonProps["variant"]>; disabled?: boolean; type: NonNullable<ButtonProps["type"]>; onPress: () => void }>) {
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
        if (!disabled) onPress();
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
      {children}
    </button>
  );
}
