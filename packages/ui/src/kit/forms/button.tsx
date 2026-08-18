/**
 * Button — action-gated (W2 §The Kit). The `onClick`/`action` prop NAMES a host
 * tool; the tree renderer binds it to the guarded, approval-gated pipe. Unlike
 * Crayon/Tambo/Tremor buttons (which can't mutate anything), this carries a real
 * host action. Standalone it just calls the bound callback.
 */
import type { PropsWithChildren } from "react";
import { useVendoThemeOrDefault } from "../../context.js";
import { Icon } from "../icon.js";
import { font, hairline, t, transitionFor, type KitStyled } from "../tokens.js";

export interface ButtonProps extends KitStyled {
  label?: string;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  /** A lucide glyph before the label — the action's own mark. */
  icon?: string;
  /** The action is in flight: a spinner takes the icon's place and the click is
   *  refused, so a slow tool cannot be sent twice. */
  loading?: boolean;
  /** Bound host-tool action (renderer-supplied). */
  onClick?: () => void;
  type?: "button" | "submit";
}

/**
 * The in-flight mark. The spin is SMIL, inside the glyph, because a CSS animation
 * needs a `@keyframes` in a stylesheet and a Kit brick carries its whole look with
 * it (tokens.ts) — so the motion travels with the mark.
 *
 * Which is also why the host's `motion: "reduced"` is read HERE rather than
 * expressed as a rule: no CSS can pause a SMIL animation, so the only way to
 * honour the setting is not to write the element. Everything else the Kit moves
 * goes through `transitionFor`, which collapses to 0ms on the same setting; a
 * spinner that kept turning through it would be the one thing in the Kit that
 * ignored the person's own answer.
 */
function Spinner({ still }: { still: boolean }) {
  return (
    <svg
      data-kit-spinner=""
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      aria-hidden
      style={{ flexShrink: 0 }}
    >
      <path d="M12 3a9 9 0 1 0 6.36 2.64" />
      {still ? null : (
        <animateTransform attributeName="transform" type="rotate" values="0 12 12;360 12 12" dur="0.7s" repeatCount="indefinite" />
      )}
    </svg>
  );
}

export function Button({ label, variant = "primary", disabled = false, icon, loading = false, onClick, type = "button", style, children }: PropsWithChildren<ButtonProps>) {
  const { motion } = useVendoThemeOrDefault();
  const primary = variant === "primary";
  const danger = variant === "danger";
  const background = primary ? t.accent : danger ? t.danger : t.surface;
  const color = primary || danger ? t.accentText : t.text;
  // In flight is not switched off. The DOM's own `disabled` is what refuses the
  // second click — and, on a submit, the second submission — but the fill and the
  // text stay: greyed out to nothing, a busy button reads as an unavailable one.
  const inert = disabled || loading;
  return (
    <button
      type={type}
      data-kit="Button"
      data-variant={variant}
      disabled={inert}
      aria-busy={loading ? true : undefined}
      onClick={() => {
        if (!inert) onClick?.();
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
        cursor: disabled ? "not-allowed" : loading ? "progress" : "pointer",
        fontWeight: t.weightEmphasis,
        lineHeight: t.lineHeightHeading,
        opacity: disabled ? 0.55 : 1,
        padding: "var(--vendo-density-control-padding, 9px 12px)",
        transition: transitionFor("background-color", "border-color", "box-shadow", "opacity"),
        ...style,
      }}
    >
      {loading ? <Spinner still={motion === "reduced"} /> : icon === undefined ? null : <Icon name={icon} />}
      {label ?? children}
    </button>
  );
}
