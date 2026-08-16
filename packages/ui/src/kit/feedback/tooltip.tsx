/**
 * Tooltip — a hint on hover or focus for whatever is nested inside it (W2).
 *
 * `label` is the shorthand a WIRE tree can express; `content` is the code-only
 * slot for a hint that is more than one line. Content wins when both are given.
 */
import { Tooltip as Base } from "@base-ui/react/tooltip";
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { popup, popupMotion, t, type KitStyled, type KitEngine, type KitRendered, given } from "../tokens.js";

/** What the browser would already stop on inside the trigger. `:disabled` is
 *  excluded because a disabled control is SKIPPED by sequential navigation:
 *  treating one as the reachable stop would drop the wrapper's fallback and
 *  leave the hint with no way in at all — and "why is this disabled?" is the
 *  thing a tooltip is most often for. */
const FOCUSABLE = [
  "a[href]",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1']):not(:disabled)",
].join(", ");

/** `aria-describedby` is a space-separated ID LIST, and this Tooltip owns
 *  exactly one entry in it. */
const described = (element: HTMLElement): string[] =>
  (element.getAttribute("aria-describedby") ?? "").split(/\s+/u).filter(Boolean);

interface TooltipOwnProps extends KitStyled {
  /** The hint, as plain text. */
  label?: string;
  /** Code-only: Kit elements rendered as the hint instead of `label`. */
  content?: ReactNode;
  /** The control the hint belongs to. */
  children?: ReactNode;
}

/** Plus any Base UI `<Tooltip.Root>` prop, handed straight to the tooltip.
 *  `style` stays the Kit's own — Tooltip.Root draws nothing, so it dresses the
 *  TRIGGER the caller sees, not the portalled hint. */
export type TooltipProps = TooltipOwnProps & KitEngine<ComponentProps<typeof Base.Root>, TooltipOwnProps>;

export function Tooltip({ label, content, children, style, pending, ...engine }: TooltipProps & KitRendered) {
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
    // Add and remove are symmetric, and BOTH read the list as it stands now.
    // Snapshotting it on the way in and restoring that snapshot on the way out
    // would erase whatever arrived while this Tooltip was mounted — a
    // validation-error id being exactly the description that matters most.
    // This component owns one token and touches no other.
    control.setAttribute("aria-describedby", [...described(control), hintId].join(" "));
    return () => {
      const rest = described(control).filter((token) => token !== hintId);
      if (rest.length === 0) control.removeAttribute("aria-describedby");
      else control.setAttribute("aria-describedby", rest.join(" "));
    };
  }, [control, hintId]);

  return (
    <Base.Root {...given(engine)}>
      {/* A span, not Base UI's default button: the thing being explained is
          often a button already, and a button inside a button is not HTML. */}
      <Base.Trigger
        data-kit="Tooltip"
        {...(control === null ? { tabIndex: 0, "aria-describedby": hintId } : {})}
        render={<span ref={wrapper} style={{ display: "inline-flex", ...style }} />}
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
