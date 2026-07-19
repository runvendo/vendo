import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoDiscoverability, useVendoTheme } from "../context.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { themeCssVariables } from "../theme.js";
import { ChromeRoot } from "./chrome-root.js";
import { hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "./discoverability.js";
import { deliverPrefill, getConversationCommands, PrefillScopeContext, registerOverlayOpener, subscribeConversationCommands, type VendoCommand } from "./overlay-registry.js";
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
   * Built-in launcher placement and content. The default is a fixed pill in
   * the given viewport corner carrying the morphing accent blob and a
   * WHITE-LABEL text — "AI agent", never a product name (ui-lane-entry). Pass
   * `"none"` to hide it and drive the overlay programmatically (via
   * `open`/`onOpenChange` or the `useVendoOverlay` hook), or the object form
   * to customize: `label` accepts any host string (`null` collapses the pill
   * to a blob-only orb) and `icon` swaps the blob for a host element.
   */
  launcher?: "bottom-right" | "bottom-left" | "none" | {
    position?: "bottom-right" | "bottom-left";
    /** Pill text. Default "AI agent"; `null` renders the blob-only orb. */
    label?: string | null;
    /** Replaces the morph-blob mark (a host logo, custom glyph, …). */
    icon?: ReactNode;
  };
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
  /**
   * The discoverability dial (ui-usage-dx §6), overriding the provider's.
   * `"default"` keeps the fire-once whisper on the launcher pill (and the
   * thread's greeting-as-tutorial); `"quiet"` turns both off. Nothing here
   * ever fires twice for the same user — the whisper marks itself seen the
   * moment it first renders.
   */
  discoverability?: VendoDiscoverability;
  /**
   * Greeting-as-tutorial content for the thread's one-time first message
   * (intro + prompt chips — the `.vendo/greeting.json` shape), overriding the
   * provider's `greeting`.
   */
  greeting?: VendoGreeting;
}

/** Whisper caption duration — long enough to read two short lines, short
 *  enough to stay ambient (~6s per the §6 decision). */
const WHISPER_MS = 6000;

/** The per-kind glyph on a command chip (mirrors the old palette row icons). */
function CommandGlyph({ kind }: { kind: VendoCommand["kind"] }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {kind === "new-conversation" ? (
        <path d="M12 5v14M5 12h14" />
      ) : kind === "open-app" ? (
        <>
          <rect width="7" height="7" x="3" y="3" rx="1" />
          <rect width="7" height="7" x="14" y="3" rx="1" />
          <rect width="7" height="7" x="3" y="14" rx="1" />
          <rect width="7" height="7" x="14" y="14" rx="1" />
        </>
      ) : (
        <>
          <path d="M3 3v18h18" />
          <path d="m7 16 4-5 4 3 4-7" />
        </>
      )}
    </svg>
  );
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
  discoverability,
  greeting,
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
  const providerDial = useVendoDiscoverability();
  const dial = discoverability ?? providerDial;
  // Launcher normalization: string forms keep their exact old meaning; the
  // object form adds white-label text/icon control. Default label is "AI
  // agent" — deliberately not a product name (white-label rule).
  const launcherConfig = typeof launcher === "object" ? launcher : {};
  const launcherPosition: "bottom-right" | "bottom-left" =
    typeof launcher === "string" && launcher !== "none" ? launcher : launcherConfig.position ?? "bottom-right";
  const launcherHidden = launcher === "none";
  // Empty/whitespace labels collapse to the blob-only orb exactly like null —
  // otherwise `label: ""` would render an icon-only button with no accessible
  // name (cubic PR#391 finding).
  const configuredLabel = launcherConfig.label === undefined ? "AI agent" : launcherConfig.label;
  const launcherLabel = configuredLabel !== null && configuredLabel.trim() === "" ? null : configuredLabel;
  // The palette's command set renders as a chip strip above the composer —
  // the one-surface replacement for the palette dialog (pick P-C).
  const commandSet = useSyncExternalStore(subscribeConversationCommands, getConversationCommands, getConversationCommands);
  const commandStrip = commandSet && commandSet.commands.length > 0 ? (
    <div className="fl-cmdstrip" role="toolbar" aria-label="Commands">
      {commandSet.commands.map(command => (
        <button key={command.id} type="button" className="fl-cmd-chip" onClick={() => commandSet.select(command)}>
          <CommandGlyph kind={command.kind} />
          {command.label}
        </button>
      ))}
    </div>
  ) : null;
  // ui-usage-dx §6 — the whisper: the first time a user actually faces the
  // pill, it pulses once and a small caption says the app can be reshaped,
  // then never again (fire-once store). Arming is REACTIVE, not mount-frozen
  // (PR #365 review): quiet dial, launcher="none", and overlay-already-open
  // states are not eligible and do not burn the flag — the moment the pill
  // becomes genuinely visible (dial flipped, launcher enabled, overlay
  // closed) is the first showing, and only that showing burns it.
  const [whisperActive, setWhisperActive] = useState(false);
  useEffect(() => {
    if (whisperActive || open || launcherHidden || dial === "quiet") return;
    if (hasSeen("whisper")) return;
    // Seen is recorded on first SHOWING, not on dismiss: a reload
    // mid-animation must never replay the whisper.
    markSeen("whisper");
    setWhisperActive(true);
  }, [whisperActive, open, launcherHidden, dial]);
  // The whisper ends after ~6s — or the instant the overlay opens, because
  // the user has found the entry point it exists to point at.
  useEffect(() => {
    if (!whisperActive) return;
    if (open) {
      setWhisperActive(false);
      return;
    }
    const timer = window.setTimeout(() => setWhisperActive(false), WHISPER_MS);
    return () => window.clearTimeout(timer);
  }, [whisperActive, open]);
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
    // The one-surface ⌘K path: a toggle request closes an open overlay instead
    // of no-opping; every other affordance strictly opens.
    if (options?.toggle === true && open) {
      setOpen(false);
      return;
    }
    if (options?.close === true) {
      if (open) setOpen(false);
      return;
    }
    setOpen(true);
    const fresh = options?.newConversation === true;
    if (fresh) setConversationEpoch(epoch => epoch + 1);
    if (typeof options?.prompt === "string" && options.prompt.length > 0) {
      deliverPrefill(
        { prompt: options.prompt, send: options.send === true },
        { scope: prefillScope.current, defer: fresh },
      );
    }
  }), [setOpen, open]);

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
          <Thread key={`${conversationKey ?? 0}:${conversationEpoch}`} discoverability={dial} firstRunGreeting={greeting} composerAccessory={commandStrip} />
        </PrefillScopeContext.Provider>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <ChromeRoot>
      {launcherHidden ? null : (
        <button
          ref={launcherRef}
          className="fl-launcher"
          data-vendo-launcher={launcherPosition}
          // Blob-only orb when the host clears the label (`label: null`).
          {...(launcherLabel === null ? { "data-vendo-launcher-bare": "" } : {})}
          // Present only while the whisper is live: keys the one-time pulse
          // (suppressed under prefers-reduced-motion — the caption still shows).
          {...(whisperActive && !open ? { "data-vendo-whisper": "" } : {})}
          type="button"
          aria-expanded={open}
          aria-controls="vendo-overlay-dialog"
          // The visible label names the button; the orb needs an explicit one.
          {...(launcherLabel === null ? { "aria-label": "AI agent" } : {})}
          onClick={() => setOpen(!open)}
        >
          {launcherConfig.icon ?? <span className="fl-launcher-blob" aria-hidden="true" />}
          {launcherLabel}
        </button>
      )}
      {/* The whisper caption rides above the pill and auto-dismisses; opening
          the overlay ends it early (it has done its job). role="status" keeps
          it polite for assistive tech. */}
      {!launcherHidden && whisperActive && !open ? (
        <div className="fl-whisper" data-vendo-launcher={launcherPosition} role="status">
          <strong>You can reshape this app</strong>
          <span>Ask Vendo to build the view you need.</span>
        </div>
      ) : null}
      {portal}
    </ChromeRoot>
  );
}
