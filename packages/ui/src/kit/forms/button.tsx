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
  /** The sentence the confirmation asks before a `danger` action fires. */
  confirm?: string;
}

export function Button({ label, variant = "primary", disabled = false, onClick, type = "button", confirm, children }: PropsWithChildren<ButtonProps>) {
  const [asking, setAsking] = useState(false);
  const primary = variant === "primary";
  const danger = variant === "danger";
  const background = primary ? t.accent : danger ? t.danger : t.surface;
  const color = primary || danger ? t.accentText : t.text;
  return (
    <>
      <button
        type={type}
        data-kit="Button"
        data-variant={variant}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          // A danger action never dispatches on its own press: the first press
          // opens the ask, the ask's own control dispatches.
          if (danger && !asking) {
            setAsking(true);
            return;
          }
          onClick?.();
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
      {asking && (
        // The confirm sits LAST and stays `secondary`: a confirmation's primary is
        // read off position, and a second `danger` here would ask all over again.
        <div
          role="dialog"
          aria-modal="true"
          aria-label={label ?? "Confirm"}
          style={{
            ...font,
            display: "flex",
            flexDirection: "column",
            gap: "var(--vendo-density-content-gap, 10px)",
            border: `1px solid ${t.border}`,
            borderRadius: t.radiusMedium,
            background: t.surface,
            padding: "var(--vendo-density-card-padding, 16px)",
            marginTop: "var(--vendo-density-content-gap, 10px)",
          }}
        >
          <span>{confirm ?? `${label ?? "This"} — this cannot be undone.`}</span>
          <div style={{ display: "flex", gap: "var(--vendo-density-inline-gap, 7px)", justifyContent: "flex-end" }}>
            <Button label="Keep it" variant="secondary" onClick={() => setAsking(false)} />
            <Button
              label={label ?? "Confirm"}
              variant="secondary"
              onClick={() => {
                setAsking(false);
                onClick?.();
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
