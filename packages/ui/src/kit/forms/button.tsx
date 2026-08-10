/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 *
 * `confirm` is the SCREEN's own ask — the writer saying "this one is
 * destructive, check with me" — and is not the guard's `confirmEach`, which is
 * the HOST declaring a tool always needs an approval. Either can be absent.
 */
import { useRef, useState, type PropsWithChildren } from "react";
import { font, t } from "../tokens.js";

export interface ButtonProps {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** The question to ask before the action runs. Set ⇒ the press opens the
   *  confirmation below instead of calling anything. */
  confirm?: string;
  /** Bound host-tool action (renderer-supplied). */
  onClick?: () => void;
  type?: "button" | "submit";
}

export function Button({ label, variant = "primary", disabled = false, confirm, onClick, type = "button", children }: PropsWithChildren<ButtonProps>) {
  const [asking, setAsking] = useState(false);
  const dialog = useRef<HTMLSpanElement>(null);
  // The confirmation the press opens: the question, the way out, then the
  // action — in that DOM order, because the primary of a confirmation is its
  // last control. It takes the button's own place rather than covering the
  // page, so it works inside any host surface and cannot trap a scroll.
  if (confirm !== undefined && asking) {
    return (
      <span
        ref={dialog}
        role="dialog"
        aria-label={confirm}
        data-kit="Confirm"
        style={{
          ...font,
          display: "inline-flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "var(--vendo-density-inline-gap, 7px)",
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusSmall,
          background: t.surface,
          padding: "var(--vendo-density-control-padding, 9px 12px)",
        }}
      >
        <span>{confirm}</span>
        <Button label="Never mind" variant="secondary" onClick={() => setAsking(false)} />
        <Button
          label={label ?? "Confirm"}
          variant={variant}
          onClick={() => {
            // A submit is the click's DEFAULT action, which the browser runs
            // after this handler — by then React has collapsed the
            // confirmation and the button has no form owner left to submit.
            // So ask the form directly, while it is still standing.
            if (type === "submit") dialog.current?.closest("form")?.requestSubmit();
            setAsking(false);
            onClick?.();
          }}
        />
      </span>
    );
  }
  const primary = variant === "primary";
  const danger = variant === "danger";
  const background = primary ? t.accent : danger ? t.danger : t.surface;
  const color = primary || danger ? t.accentText : t.text;
  return (
    <button
      // A submit that must be confirmed cannot submit on this press — the
      // confirmation's own control carries the submit.
      type={confirm === undefined ? type : "button"}
      data-kit="Button"
      data-variant={variant}
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        if (confirm !== undefined) setAsking(true);
        else onClick?.();
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
