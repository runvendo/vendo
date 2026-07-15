import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useVendoTheme } from "../context.js";
import { themeCssVariables } from "../theme.js";
import { ChromeRoot } from "./chrome-root.js";
import { VendoThread } from "./vendo-thread.js";

const FOCUSABLE = "button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])";

export interface VendoOverlayProps {
  /** Controlled open state — pair with `onOpenChange`. Omit for uncontrolled. */
  open?: boolean;
  /** Initial state in uncontrolled mode (default `false`). */
  defaultOpen?: boolean;
  /** Fires for every open/close request: launcher click, close button, Escape, scrim click, or programmatic toggles. */
  onOpenChange?(open: boolean): void;
  /**
   * Built-in launcher placement. The default is a fixed, brand-styled pill in
   * the given viewport corner; pass `"none"` to hide it and drive the overlay
   * programmatically (via `open`/`onOpenChange` or the `useVendoOverlay` hook).
   */
  launcher?: "bottom-right" | "bottom-left" | "none";
}

/** display:none/visibility:hidden elements silently swallow focus() — skip them. */
function canReceiveFocus(element: HTMLElement | null): element is HTMLElement {
  if (!element || !element.isConnected) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

/** 08-ui §4 — floating modal launcher with focus containment and restoration.
 *  Supported entry API (ENG-220): positioned launcher by default, controlled +
 *  uncontrolled programmatic open/close, panel portaled to document.body with
 *  body scroll-lock and an inert background while open. */
export function VendoOverlay({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  launcher = "bottom-right",
}: VendoOverlayProps = {}) {
  const controlled = openProp !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlled ? openProp : uncontrolledOpen;
  const theme = useVendoTheme();
  const launcherRef = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const portalRoot = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);

  const setOpen = useCallback((next: boolean) => {
    if (next && !open && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      opener.current = document.activeElement;
    }
    if (!controlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange, open]);

  // Focus correctness across BOTH modes (controlled flips never pass through
  // setOpen, so transitions are observed here): on open, capture the invoking
  // element and autofocus the composer; on close, restore focus to the invoker
  // — falling back to the launcher — skipping anything that cannot visibly
  // receive focus (e.g. a display:none launcher) so focus never lands on body.
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) {
      if (!opener.current && document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
        opener.current = document.activeElement;
      }
      queueMicrotask(() => {
        const panel = dialog.current;
        const composer = panel?.querySelector<HTMLElement>("textarea:not([disabled])");
        (composer ?? panel?.querySelector<HTMLElement>(FOCUSABLE))?.focus();
      });
    } else {
      const invoker = opener.current;
      opener.current = null;
      queueMicrotask(() => {
        for (const candidate of [invoker, launcherRef.current]) {
          if (canReceiveFocus(candidate)) {
            candidate.focus();
            return;
          }
        }
      });
    }
  }, [open]);

  // While open: lock body scroll and make everything behind the portal inert
  // (the scrim + panel live in their own body-level subtree). Restored on
  // close AND on unmount-while-open via the effect cleanup.
  useEffect(() => {
    if (!open) return;
    const wrapper = portalRoot.current;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const inerted: Element[] = [];
    for (const child of Array.from(body.children)) {
      if (child === wrapper || child.tagName === "SCRIPT" || child.tagName === "STYLE" || child.hasAttribute("inert")) continue;
      child.setAttribute("inert", "");
      inerted.push(child);
    }
    return () => {
      body.style.overflow = previousOverflow;
      for (const element of inerted) element.removeAttribute("inert");
    };
  }, [open]);

  const close = () => setOpen(false);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // The panel escapes the host's stacking/transform/filter context entirely:
  // it is portaled to document.body. The wrapper is display:contents but
  // carries the .vendo-root token bridge + contract variables, so the panel
  // stays fully brand-themed outside the host ChromeRoot.
  const portal = open && typeof document !== "undefined" ? createPortal(
    <div
      ref={portalRoot}
      className="vendo-root fl-overlay-portal"
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)" } as CSSProperties}
    >
      {/* Click-outside-to-dismiss: the visible frosted scrim reads as clickable,
          so honor it (matching the palette). Keyboard users have Esc + the X. */}
      <div className="fl-overlay-scrim" onMouseDown={close} />
      <div ref={dialog} id="vendo-overlay-dialog" className="fl-overlay-panel" role="dialog" aria-modal="true" aria-label="Vendo assistant" onKeyDown={onKeyDown}>
        <strong className="fl-sr-only">Vendo</strong>
        <button className="fl-overlay-close" type="button" aria-label="Close Vendo" onClick={close}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="fl-sr-only">Close</span>
        </button>
        <VendoThread />
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <ChromeRoot>
      {launcher === "none" ? null : (
        <button
          ref={launcherRef}
          className="fl-launcher"
          data-vendo-launcher={launcher}
          type="button"
          aria-expanded={open}
          aria-controls="vendo-overlay-dialog"
          onClick={() => setOpen(!open)}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" />
            <path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8L18 14Z" />
          </svg>
          Vendo
        </button>
      )}
      {portal}
    </ChromeRoot>
  );
}
