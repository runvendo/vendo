import { useCallback, useEffect, useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useVendoTheme } from "../context.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { themeCssVariables } from "../theme.js";
import { ChromeRoot } from "./chrome-root.js";
import { deliverPrefill, PrefillScopeContext, registerOverlayOpener } from "./overlay-registry.js";
import { VendoThread, type VendoThreadProps } from "./thread/index.js";

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
  /**
   * Change to discard the current conversation and start a fresh thread
   * (ENG-221). `useVendoOverlay().newConversation()` drives this for you;
   * hosts managing their own state can bump any number/string. The panel's
   * built-in new-conversation button works with or without this prop.
   */
  conversationKey?: string | number;
  /**
   * The one sanctioned component-injection point (the eject seam): a thread
   * component the panel renders in place of the built-in `VendoThread`. The
   * overlay stays the positioning shell — portal, scrim, focus, mobile sheet —
   * while an ejected (or fully custom) thread supplies the conversation
   * pixels. It receives `VendoThreadProps` (all optional), so a plain
   * zero-prop component works too.
   */
  thread?: ComponentType<VendoThreadProps>;
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
  conversationKey,
  thread: Thread = VendoThread,
}: VendoOverlayProps = {}) {
  const controlled = openProp !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlled ? openProp : uncontrolledOpen;
  // ENG-221: closing must HIDE the panel, not unmount it — the conversation
  // (VendoThread's chat state + adopted thr_ id) lives in the portal subtree
  // and survives every close/reopen within the page session. Mount lazily on
  // first open, then keep mounted (render-phase derived state, no extra pass).
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  // The explicit new-conversation affordance: remount VendoThread under a new
  // key so the next turn starts with no threadId (the server mints a fresh
  // one). Combined with the prop so the hook's newConversation() works too.
  const [conversationEpoch, setConversationEpoch] = useState(0);
  const theme = useVendoTheme();
  const takeover = useMobileTakeover();
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
    const inert = (child: Element) => {
      if (child === wrapper || child.tagName === "SCRIPT" || child.tagName === "STYLE" || child.hasAttribute("inert")) return;
      // Never inert another modal surface: the palette's takeover portal can
      // mount above this overlay (Cmd/Ctrl+K while open) and must stay
      // interactive — an inert ancestor would freeze the whole dialog.
      if (child.matches('[aria-modal="true"]') || child.querySelector('[aria-modal="true"]')) return;
      child.setAttribute("inert", "");
      inerted.push(child);
    };
    for (const child of Array.from(body.children)) inert(child);
    // ENG-228: body children can also appear WHILE the overlay is open — the
    // page/palette TakeoverPortals mount on a breakpoint flip, hosts mint
    // toast portals. The open-time snapshot alone would leave those
    // interactive behind the modal scrim, so keep watching.
    const observer = new MutationObserver(records => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element && node.parentElement === body) inert(node);
        }
      }
    });
    observer.observe(body, { childList: true });
    return () => {
      observer.disconnect();
      body.style.overflow = previousOverflow;
      for (const element of inerted) element.removeAttribute("inert");
    };
  }, [open]);

  const close = () => setOpen(false);

  // The prefill scope: this overlay's composer registers under it, so a
  // delivered prompt reaches THIS overlay's thread — not an embedded
  // VendoThread/VendoPage composer that happened to register later.
  const prefillScope = useRef(Symbol("vendo-overlay-prefill"));

  // Registry opener (ui-usage-dx §2): lets slot remix / trigger / palette
  // affordances open this overlay — optionally preloading a prompt or starting
  // fresh — without a ref. The prompt goes through the registry's scoped
  // prefill hand-off, which parks it until the thread's composer mounts
  // (first open) or delivers immediately (already mounted, even while
  // hidden). newConversation defers delivery past the outgoing composer:
  // the epoch bump remounts the thread, and only the fresh composer may
  // drain the prompt (a live delivery would hand it to the one unmounting).
  useEffect(() => registerOverlayOpener(options => {
    setOpen(true);
    const fresh = options?.newConversation === true;
    if (fresh) setConversationEpoch(epoch => epoch + 1);
    if (typeof options?.prompt === "string" && options.prompt.length > 0) {
      deliverPrefill(
        { prompt: options.prompt, send: options.send === true },
        { scope: prefillScope.current, defer: fresh },
      );
    }
  }), [setOpen]);

  const newConversation = () => {
    setConversationEpoch(epoch => epoch + 1);
    // The remounted thread lands on the empty composer — put focus there so
    // the affordance reads as "ready for a fresh start", not a dead click.
    queueMicrotask(() => dialog.current?.querySelector<HTMLElement>("textarea:not([disabled])")?.focus());
  };

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
  const portal = hasOpened && typeof document !== "undefined" ? createPortal(
    <div
      ref={portalRoot}
      className="vendo-root fl-overlay-portal"
      data-vendo-motion={theme.motion}
      data-vendo-density={theme.density}
      // Closed = hidden, NOT unmounted (ENG-221): inline display:none beats the
      // class's display:contents, drops the subtree out of the a11y tree and
      // tab order, and replays the open animation on reveal — while the thread
      // state (and any in-flight stream) lives on underneath.
      style={{ ...themeCssVariables(theme), fontFamily: "var(--vendo-font-family)", fontSize: "var(--vendo-font-size)", ...(open ? {} : { display: "none" }) } as CSSProperties}
    >
      {/* Click-outside-to-dismiss: the visible frosted scrim reads as clickable,
          so honor it. Dismissal fires on click (not mousedown) so the full
          press-release is consumed by the scrim — closing on mousedown lets the
          mouseup land on the revealed page and steal the restored focus. */}
      <div className="fl-overlay-scrim" onClick={close} />
      {/* ENG-228: below the breakpoint the panel goes full-bleed (`.fl-takeover`,
          the designed Intercom-style mode) and carries the virtual-keyboard
          inset var so the composer stays above the on-screen keyboard. */}
      <div
        ref={dialog}
        id="vendo-overlay-dialog"
        className={`fl-overlay-panel${takeover.active ? " fl-takeover" : ""}`}
        style={takeover.style}
        role="dialog"
        aria-modal="true"
        aria-label="Vendo assistant"
        onKeyDown={onKeyDown}
      >
        <strong className="fl-sr-only">Vendo</strong>
        {/* ENG-221: the explicit fresh-start affordance — closing never discards
            the conversation, so THIS is how a new one begins. Shares the close
            button's quiet header treatment; .fl-overlay-new only shifts it left. */}
        <button className="fl-overlay-close fl-overlay-new" type="button" aria-label="New conversation" onClick={newConversation}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span className="fl-sr-only">New conversation</span>
        </button>
        <button className="fl-overlay-close" type="button" aria-label="Close Vendo" onClick={close}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
          <span className="fl-sr-only">Close</span>
        </button>
        <PrefillScopeContext.Provider value={prefillScope.current}>
          <Thread key={`${conversationKey ?? 0}:${conversationEpoch}`} />
        </PrefillScopeContext.Provider>
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
