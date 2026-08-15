/**
 * Tooltip — a hint on hover or focus for whatever is nested inside it (W2).
 *
 * `label` is the shorthand a WIRE tree can express; `content` is the code-only
 * slot for a hint that is more than one line. Content wins when both are given.
 */
import { Tooltip as Base } from "@base-ui/react/tooltip";
import { useId, type ReactNode } from "react";
import { popup, popupMotion, t } from "../tokens.js";

export interface TooltipProps {
  /** The hint, as plain text. */
  label?: string;
  /** Code-only: Kit elements rendered as the hint instead of `label`. */
  content?: ReactNode;
  /** The control the hint belongs to. */
  children?: ReactNode;
}

export function Tooltip({ label, content, children }: TooltipProps) {
  // Base UI's tooltip parts carry no role and no description wiring of their
  // own, so the hint would be invisible to a screen reader. Both are ours.
  const hintId = useId();
  return (
    <Base.Root>
      {/* A span, not Base UI's default button: the thing being explained is
          often a button already, and a button inside a button is not HTML.
          `tabIndex` is what keeps the hint reachable without a mouse. */}
      <Base.Trigger data-kit="Tooltip" aria-describedby={hintId} render={<span tabIndex={0} style={{ display: "inline-flex" }} />}>
        {children}
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner sideOffset={6} style={{ zIndex: 2 }}>
          <Base.Popup
            id={hintId}
            role="tooltip"
            style={(state) => ({
              ...popup,
              ...popupMotion(state),
              // A hint is chrome, not a surface: it inverts so it reads as a
              // layer above the page rather than another card on it.
              background: t.text,
              color: t.background,
              border: 0,
              fontSize: "0.85em",
              maxWidth: 240,
              padding: "5px 8px",
            })}
          >
            {content ?? label}
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
