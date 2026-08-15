/**
 * Tooltip — a hint on hover or focus for whatever is nested inside it (W2).
 *
 * `label` is the shorthand a WIRE tree can express; `content` is the code-only
 * slot for a hint that is more than one line. Content wins when both are given.
 */
import { Tooltip as Base } from "@base-ui/react/tooltip";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { popup, popupMotion, t } from "../tokens.js";

/** What the browser would already stop on inside the trigger. */
const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]:not([tabindex='-1'])";

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
  const wrapper = useRef<HTMLSpanElement>(null);
  // WHICH element wears them is the whole question. Wrapping a control that can
  // already be reached in a focusable span cost the keyboard TWO stops — the
  // described wrapper, then the real, undescribed control — so the control
  // itself is described when there is one, and the wrapper only stands in for a
  // child that could not be reached at all (a bare glyph).
  const [control, setControl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setControl(wrapper.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null);
  }, [children]);
  useEffect(() => {
    if (control === null) return undefined;
    // Appended, never assigned: a described control (an Input with a hint) is
    // already pointing at something, and aria-describedby is a LIST.
    const existing = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", existing === null ? hintId : `${existing} ${hintId}`);
    return () => {
      if (existing === null) control.removeAttribute("aria-describedby");
      else control.setAttribute("aria-describedby", existing);
    };
  }, [control, hintId]);

  return (
    <Base.Root>
      {/* A span, not Base UI's default button: the thing being explained is
          often a button already, and a button inside a button is not HTML. */}
      <Base.Trigger
        data-kit="Tooltip"
        {...(control === null ? { tabIndex: 0, "aria-describedby": hintId } : {})}
        render={<span ref={wrapper} style={{ display: "inline-flex" }} />}
      >
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
