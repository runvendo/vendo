/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 *
 * `confirm` is the destructive step, and it lives here rather than in a
 * component of its own: a confirmation is the second half of ONE action, so
 * `<Button confirm="…">` is the whole vocabulary a document needs. Without it
 * the only way to ask a question before a write was a hand-rolled island — and
 * an island is where a screen loses the host's theme.
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
  /** Ask this before the action runs. The press opens the confirmation and
   *  nothing else; only the confirmation's own control calls the tool. */
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
        onClick={(event) => {
          if (disabled) return;
          if (confirm === undefined) {
            onClick?.();
            return;
          }
          // preventDefault so a submit-typed button asks before the browser
          // submits its form: the confirmation, not the press, is the action.
          event.preventDefault();
          setAsking(true);
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
      {asking && confirm !== undefined
        ? (
          <ConfirmDialog
            question={confirm}
            label={label ?? "Confirm"}
            onCancel={() => setAsking(false)}
            onConfirm={() => {
              setAsking(false);
              onClick?.();
            }}
          />
        )
        : null}
    </>
  );
}

export interface ConfirmDialogProps {
  /** The question, written by whoever composed the screen. */
  question: string;
  /** The primary control's label — the action being confirmed, in its words. */
  label: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The confirmation step behind `confirm` on Button and Form. Internal: it has no
 * name a document may write, so it is not a registry entry. Two things about it
 * are load-bearing rather than cosmetic:
 *
 * - it is a `[role=dialog]`, which is what every reader of a screen — a person,
 *   a screen reader, a click probe — recognises as "answer me before this
 *   happens";
 * - the primary control sits LAST, after the way out, so a reader that answers
 *   a confirmation by taking its last control lands on the action rather than
 *   on the escape hatch.
 *
 * It is mounted only while it is being asked. A hidden button is still a button
 * to anything walking the page's controls, and would read as a dead one.
 */
export function ConfirmDialog({ question, label, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div
      data-kit="Confirm"
      role="dialog"
      aria-modal="true"
      aria-label={question}
      style={{
        ...font,
        position: "fixed",
        inset: 0,
        zIndex: 2147483000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: `color-mix(in srgb, ${t.text} 38%, transparent)`,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--vendo-density-content-gap, 14px)",
          maxWidth: 380,
          border: `1px solid ${t.border}`,
          borderRadius: t.radiusLarge,
          background: t.surface,
          boxShadow: `0 12px 32px color-mix(in srgb, ${t.text} 22%, transparent)`,
          padding: "var(--vendo-density-card-padding, 16px 18px)",
        }}
      >
        <span style={{ lineHeight: 1.45 }}>{question}</span>
        <div style={{ display: "flex", gap: "var(--vendo-density-inline-gap, 8px)", justifyContent: "flex-end" }}>
          <Button label="Keep it" variant="secondary" onClick={onCancel} />
          <Button label={label} variant="danger" onClick={onConfirm} />
        </div>
      </div>
    </div>
  );
}
