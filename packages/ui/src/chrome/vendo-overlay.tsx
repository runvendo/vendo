import type { UIPayload } from "@vendoai/core";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useVendoContext, useVendoDiscoverability, useVendoTheme } from "../context.js";
import { useMobileTakeover } from "../hooks/use-mobile-takeover.js";
import { themeCssVariables } from "../theme.js";
import { PayloadView } from "../tree/renderer.js";
import { BeatRail } from "./build-beat.js";
import { ChromeRoot } from "./chrome-root.js";
import { hasSeen, markSeen, type VendoDiscoverability, type VendoGreeting } from "./discoverability.js";
import { inertBehind } from "./inert-behind.js";
import { LauncherFace, LauncherToast, useLauncherStatus } from "./launcher-status.js";
import { deliverPrefill, PrefillScopeContext, registerOverlayOpener } from "./overlay-registry.js";
import { usePinAction, usePinNudge } from "./pin-ceremony.js";
import { IDLE_RUN_ACTIVITY, runActivity, subscribeRunActivity } from "./run-activity.js";
import {
  escapeIntent,
  expandedStageRect,
  featuredEmbed,
  initialSplitViewState,
  SplitViewContext,
  splitViewReducer,
  type MorphRect,
  type SplitViewContextValue,
} from "./split-view.js";
import { appTitle } from "./thread/message-data.js";
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

/* ------------------------------------------------------------------ */
/* The expand/collapse embed morph (MorphToast's ghost pattern)        */
/* ------------------------------------------------------------------ */

const MORPH_MS = 450;
/** The ghost keeps tracking its (still-moving) target while it fades. */
const MORPH_FADE_MS = 160;

/** easeOutQuint — the exact curve of the panel spring
    `cubic-bezier(.22, 1, .36, 1)` (easings.net), so the ghost, the panes and
    the panel arrive together. */
function morphEase(t: number): number {
  return 1 - (1 - t) ** 5;
}

/** The shared-element half of the split-view transition: a STATIC clone of
    the embed frame flies between its rail-card rect and the stage rect while
    the panel/rail springs run, so the microapp reads as GROWING out of the
    conversation into the workspace (and shrinking back) rather than a pane
    resizing around it. rAF-driven rather than a CSS transition because the
    TARGET can move mid-flight — on collapse the rail card shifts and rewraps
    as the panel contracts, so `target` is re-read every frame and the flight
    converges on the card wherever it settles. Purely decorative —
    aria-hidden, pointer-events none, unmounts after one flight; the LIVE
    content underneath never remounts. */
function EmbedMorphGhost({ from, target, clipTo, clone, mode, onDone }: {
  from: MorphRect;
  /** Live target rect, sampled per frame (constant on expand, where the
      settled stage rect is computed up front; the card's rect on collapse). */
  target(): MorphRect;
  /** The panel's live rect: the ghost is fixed ABOVE the panel (which clips
      its own overflow), so without this a flight to/from a card scrolled
      partly out of the rail would overhang the panel onto the backdrop. */
  clipTo(): MorphRect | undefined;
  clone: HTMLElement;
  mode: "in" | "out";
  onDone(): void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const scaleRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const targetRef = useRef(target);
  targetRef.current = target;
  const clipRef = useRef(clipTo);
  clipRef.current = clipTo;
  useEffect(() => {
    const box = boxRef.current;
    const scaleEl = scaleRef.current;
    if (!box || !scaleEl) return;
    scaleEl.appendChild(clone);
    const started = performance.now();
    let raf = requestAnimationFrame(function frame(now: number) {
      const elapsed = now - started;
      const p = morphEase(Math.min(1, elapsed / MORPH_MS));
      const to = targetRef.current();
      const mix = (a: number, b: number) => a + (b - a) * p;
      box.style.top = `${mix(from.top, to.top)}px`;
      box.style.left = `${mix(from.left, to.left)}px`;
      box.style.width = `${mix(from.width, to.width)}px`;
      box.style.height = `${mix(from.height, to.height)}px`;
      scaleEl.style.transform = `scale(${mix(1, to.width / from.width)})`;
      const clip = clipRef.current();
      if (clip) {
        const boxTop = mix(from.top, to.top);
        const boxLeft = mix(from.left, to.left);
        box.style.clipPath = `inset(${Math.max(0, clip.top - boxTop)}px `
          + `${Math.max(0, boxLeft + mix(from.width, to.width) - (clip.left + clip.width))}px `
          + `${Math.max(0, boxTop + mix(from.height, to.height) - (clip.top + clip.height))}px `
          + `${Math.max(0, clip.left - boxLeft)}px round 14px)`;
      }
      // The ghost fades out over the landing so the live surface (stage
      // frame or rail card) takes over without a hard swap.
      const fade = (elapsed - (MORPH_MS - MORPH_FADE_MS / 2)) / MORPH_FADE_MS;
      box.style.opacity = `${Math.min(1, Math.max(0, 1 - fade))}`;
      if (elapsed < MORPH_MS + MORPH_FADE_MS / 2) {
        raf = requestAnimationFrame(frame);
      } else {
        doneRef.current();
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      clone.remove();
    };
  }, [clone, from]);
  return (
    <div
      className="fl-embed-ghost"
      aria-hidden="true"
      data-mode={mode}
      ref={boxRef}
      style={{ top: from.top, left: from.left, width: from.width, height: from.height }}
    >
      <div ref={scaleRef} className="fl-embed-ghost-scale" style={{ width: from.width }} />
    </div>
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
  const { client, components } = useVendoContext();
  const pin = usePinAction();

  // 2026-07 demo feedback — the expandable split-view workspace (split-view.tsx
  // owns the pure state machine). Expanded, the featured microapp renders
  // large on a left stage and the conversation docks as the right rail; the
  // mobile takeover is untouched (full-bleed already — expansion is a no-op
  // below the breakpoint).
  const [splitState, dispatchSplit] = useReducer(splitViewReducer, initialSplitViewState);
  const expanded = splitState.expanded && !takeover.active;
  const featured = featuredEmbed(splitState);
  // The workspace IS the mockup's pin: one app on the stage at a time, so its
  // pin invites until the user takes it (§10.1 — the user pins, never the agent).
  const stageNudge = usePinNudge(featured?.appId ?? "", featured !== undefined);
  // The collapse ANIMATES: like the connect tray's exit walk, the stage stays
  // mounted through expanded → collapsing → collapsed so the featured app
  // doesn't blink out before the panes finish sliding. Render-phase state
  // adjustment (an effect would commit one stage-less frame first).
  const [stagePhase, setStagePhase] = useState<"collapsed" | "expanded" | "collapsing">(expanded ? "expanded" : "collapsed");
  if (expanded && stagePhase !== "expanded") setStagePhase("expanded");
  if (!expanded && stagePhase === "expanded") setStagePhase("collapsing");
  useEffect(() => {
    if (stagePhase !== "collapsing") return;
    const timer = window.setTimeout(() => setStagePhase("collapsed"), 480);
    return () => window.clearTimeout(timer);
  }, [stagePhase]);
  // The subtle auto-suggest: a NEW app embed rendering while the workspace is
  // collapsed pulses the expand affordance once (never a modal, never a toast).
  const [suggestExpand, setSuggestExpand] = useState(false);
  const splitStateRef = useRef(splitState);
  splitStateRef.current = splitState;
  const suggestTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(suggestTimer.current), []);
  useEffect(() => {
    if (expanded) setSuggestExpand(false);
  }, [expanded]);
  // The register/remove/feature callbacks are IDENTITY-STABLE (refs +
  // dispatch only): the thread's app cards key registration effects on them,
  // so churning identities would re-run every card's cleanup on each
  // expand/feature flip — remove-embed then clears the explicit pick the
  // user just made.
  const featureApp = useCallback((appId: string) => dispatchSplit({ type: "feature", appId }), []);
  // The compact card's Expand affordance: expand the workspace with THAT app
  // featured. Rides a ref to setWorkspace (defined below — it closes over
  // per-render state for the ghost flight) so the identity stays stable.
  const setWorkspaceRef = useRef<(next: boolean, featureAppId?: string, auto?: boolean) => void>(() => undefined);
  const expandTo = useCallback((appId: string) => setWorkspaceRef.current(true, appId), []);
  // The plan hint's ONE shot per BUILD (§2 G1 + ruling 23). The ledger lives in
  // the split state, not in the calling card, so the shot is spent even when the
  // hint arrives against an already-open workspace — otherwise the second staged
  // view of a turn never records, and the first Back-to-chat re-opens the panel
  // on the user's behalf. It is keyed by the BUILD, so a new build the user
  // ASKED for can still stage after they collapsed the previous one.
  const autoStage = useCallback((appId: string, buildKey: string) => {
    const state = splitStateRef.current;
    if (state.autoStaged.includes(buildKey)) return;
    dispatchSplit({ type: "auto-stage", buildKey });
    if (state.expanded) return;
    setWorkspaceRef.current(true, appId, true);
  }, []);
  const registerEmbed = useCallback((appId: string, payload: unknown) => {
    const state = splitStateRef.current;
    if (!state.expanded && !state.embeds.some(embed => embed.appId === appId)) {
      setSuggestExpand(true);
      window.clearTimeout(suggestTimer.current);
      suggestTimer.current = window.setTimeout(() => setSuggestExpand(false), 6_000);
    }
    dispatchSplit({ type: "embed", appId, payload });
  }, []);
  const removeEmbed = useCallback((appId: string) => dispatchSplit({ type: "remove-embed", appId }), []);
  const featuredAppId = expanded ? featured?.appId : undefined;
  const splitContextValue = useMemo<SplitViewContextValue>(() => ({
    expanded,
    featuredAppId,
    feature: featureApp,
    expandTo,
    autoStage,
    registerEmbed,
    removeEmbed,
  }), [expanded, featuredAppId, featureApp, expandTo, autoStage, registerEmbed, removeEmbed]);

  // Yousef polish (2026-07): the expand↔collapse must read as ONE continuous
  // morph — a FLIP-style shared-element flight (EmbedMorphGhost above) of the
  // featured embed between its rail card and the stage, riding the same
  // spring as the panel/rail transitions. Measured start, computed target
  // (expandedStageRect — a mid-transition DOM read would return the compact
  // layout). Skipped under reduced motion (everything snaps), in the
  // takeover, when there is no featured embed, and in layout-less
  // environments (jsdom rects are 0).
  const [embedGhost, setEmbedGhost] = useState<{
    id: number;
    mode: "in" | "out";
    from: MorphRect;
    target(): MorphRect;
    clipTo(): MorphRect | undefined;
    clone: HTMLElement;
  } | null>(null);
  const ghostSeq = useRef(0);
  const setWorkspace = (next: boolean, featureAppId?: string, auto = false) => {
    if (next === splitState.expanded) {
      return;
    }
    // The compact card's Expand affordance names WHICH app to stage; the
    // feature dispatch below lands in the same commit as the expand, but the
    // ghost flight must read the target NOW (state hasn't reduced yet).
    const targetAppId = featureAppId
      ?? (featured !== undefined ? featured.appId : undefined);
    const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rectOf = (element: Element | null | undefined): MorphRect | undefined => {
      const rect = element?.getBoundingClientRect();
      return rect !== undefined && rect.width > 0 && rect.height > 0
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : undefined;
    };
    const makeClone = (element: HTMLElement, width: number): HTMLElement => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.style.width = `${width}px`;
      clone.style.margin = "0";
      clone.style.pointerEvents = "none";
      return clone;
    };
    if (!takeover.active && !reduced && targetAppId !== undefined && typeof window !== "undefined") {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(targetAppId)
        : targetAppId;
      const cardEl = dialog.current?.querySelector<HTMLElement>(`[data-vendo-app-embed="${escaped}"]`);
      const clipTo = () => rectOf(dialog.current);
      if (next) {
        const from = rectOf(cardEl);
        if (cardEl && from) {
          const to = expandedStageRect({ width: window.innerWidth, height: window.innerHeight });
          setEmbedGhost({
            id: ++ghostSeq.current,
            mode: "in",
            from,
            target: () => to,
            clipTo,
            clone: makeClone(cardEl, from.width),
          });
        }
      } else {
        const stageEl = dialog.current?.querySelector<HTMLElement>(".fl-stage");
        const from = rectOf(stageEl);
        let last = rectOf(cardEl);
        if (stageEl && cardEl && from && last) {
          // Track the card LIVE: it shifts and rewraps while the panel
          // contracts, and the flight must converge on wherever it settles.
          const target = () => {
            last = rectOf(cardEl) ?? last;
            return last as MorphRect;
          };
          setEmbedGhost({ id: ++ghostSeq.current, mode: "out", from, target, clipTo, clone: makeClone(stageEl, from.width) });
        }
      }
    }
    if (featureAppId !== undefined) dispatchSplit({ type: "feature", appId: featureAppId });
    dispatchSplit(next ? { type: "expand", ...(auto ? { auto: true } : {}) } : { type: "collapse" });
  };
  setWorkspaceRef.current = setWorkspace;
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
  // Demo-refresh 2026-07-23: the palette's chip strip above the composer is
  // gone (it read as clutter and duplicated app entry points). The command
  // registry seam stays — the palette hotkey still opens this overlay and a
  // host `onCommand` still routes — there is just no built-in strip UI.
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
  // The registry opener effect only re-registers on a later passive flush, so a
  // ⌘K landing between the hide-commit and that flush reached a closure with a
  // stale `open` and toggled a closed overlay shut (the dialog never mounted).
  // The ref always reads the committed value, independent of re-registration.
  const openRef = useRef(open);
  openRef.current = open;

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
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    const release = inertBehind(portalRoot.current);
    return () => {
      release();
      body.style.overflow = previousOverflow;
    };
  }, [open]);

  const close = () => setOpen(false);

  // The prefill scope: this overlay's composer registers under it, so a
  // delivered prompt reaches THIS overlay's thread — not an embedded
  // VendoThread/VendoPage composer that happened to register later.
  const prefillScope = useRef(Symbol("vendo-overlay-prefill"));

  // Registry opener (ui-usage-dx §2): lets trigger / palette / remix-popover
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
    if (options?.toggle === true && openRef.current) {
      setOpen(false);
      return;
    }
    if (options?.close === true) {
      if (openRef.current) setOpen(false);
      return;
    }
    setOpen(true);
    const fresh = options?.newConversation === true;
    if (fresh) setConversationEpoch(epoch => epoch + 1);
    const prompt = typeof options?.prompt === "string" ? options.prompt : "";
    if (prompt.length > 0) {
      deliverPrefill(
        {
          prompt,
          send: options?.send === true,
          ...(typeof options?.context === "string" && options.context.length > 0
            ? { context: options.context }
            : {}),
        },
        { scope: prefillScope.current, defer: fresh },
      );
    }
  }), [setOpen]);

  // LANE D (spec §2, §3, §4) — what the pill says while the user is elsewhere:
  // the live beat of a run that kept going after they left, the result toast
  // that leads back into the record, the badge of asks and the dot of unseen
  // results. The panel's own thread id scopes the toast to runs this panel can
  // actually show.
  const [panelThreadId, setPanelThreadId] = useState<string>();
  // §3.4 + §10.2 — the running turn's beats, for the stage's rail. The thread
  // lives in the OTHER pane's React tree, so this rides the run-activity store
  // the launcher pill already reads — the one channel for what a surface
  // outside the conversation may know about a turn inside it.
  //
  // SCOPED, because that store answers for whichever surface is running and a
  // host may mount several (`/concurrent` mounts an embedded thread beside this
  // overlay): unscoped, an idle workspace narrated somebody else's build.
  //
  // Stricter than the toast's rule two lines below, deliberately. A toast is news
  // the user might otherwise miss, so it fails toward SHOWING and lets an
  // unidentified run through; a rail claims "this is what YOUR workspace is
  // doing", so it fails toward SILENCE — an unidentifiable turn narrates nowhere
  // rather than in the wrong panel.
  const activity = useSyncExternalStore(subscribeRunActivity, runActivity, () => IDLE_RUN_ACTIVITY);
  const beats = activity.threadId !== undefined && activity.threadId === panelThreadId
    ? activity.beats
    : IDLE_RUN_ACTIVITY.beats;
  const status = useLauncherStatus({
    open,
    ...(panelThreadId === undefined ? {} : { threadId: panelThreadId }),
    onOpen: () => setOpen(true),
  });

  const newConversation = () => {
    setConversationEpoch(epoch => epoch + 1);
    // The remounted thread lands on the empty composer — put focus there so
    // the affordance reads as "ready for a fresh start", not a dead click.
    queueMicrotask(() => dialog.current?.querySelector<HTMLElement>("textarea:not([disabled])")?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // Split-view order: Escape collapses the workspace first, closes the
      // overlay second (escapeIntent in split-view.tsx; the takeover ignores
      // expansion, so below the breakpoint Escape closes as before).
      if (!takeover.active && escapeIntent(splitState) === "collapse") {
        setWorkspace(false);
        return;
      }
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
        {...(expanded ? { "data-vendo-expanded": "" } : {})}
        {...(embedGhost ? { "data-vendo-ghost": embedGhost.mode } : {})}
        style={takeover.style}
        role="dialog"
        aria-modal="true"
        aria-label="Vendo assistant"
        onKeyDown={onKeyDown}
      >
        <strong className="fl-sr-only">Vendo</strong>
        {/* The split-view expand/collapse affordance (2026-07). Hidden below
            the breakpoint — the takeover is already full-bleed. A fresh app
            embed landing while collapsed pulses it once (data-vendo-suggest). */}
        {!takeover.active ? (
          <button
            className="fl-overlay-close fl-overlay-expand"
            type="button"
            aria-label={expanded ? "Collapse workspace" : "Expand workspace"}
            aria-pressed={expanded}
            {...(suggestExpand && !expanded ? { "data-vendo-suggest": "" } : {})}
            onClick={() => setWorkspace(!splitState.expanded)}
          >
            {expanded ? (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
            )}
            <span className="fl-sr-only">{expanded ? "Collapse workspace" : "Expand workspace"}</span>
          </button>
        ) : null}
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
        {/* The split shell is ALWAYS in the tree with the thread in the same
            slot, so expanding/collapsing never remounts the conversation
            (the same invariant close/reopen honors, ENG-221). Collapsed, the
            stage pane is width-0 and empty; the rail IS the whole panel. */}
        <SplitViewContext.Provider value={splitContextValue}>
          <div className="fl-split">
            <div className="fl-split-stage" key="stage" {...(expanded ? {} : { "aria-hidden": true })}>
              {stagePhase !== "collapsed" ? (
                <>
                {featured ? (
                  <div className="fl-stage" key={featured.appId}>
                    <div className="fl-stage-bar">
                      <span className="fl-appcard-dot" aria-hidden="true" />
                      <span className="fl-stage-name">{appTitle(featured.payload) ?? "Your app"}</span>
                      {/* Pin from fullscreen (2026-07 demo feedback): the same
                          host onPin seam the in-thread card bar uses. A pin
                          from the stage CLOSES the whole overlay — the user
                          lands back in the product with the app pinned. */}
                      {pin ? (
                        <button
                          type="button"
                          className="fl-barpin fl-stage-pin"
                          {...(stageNudge === undefined ? {} : { "data-vendo-pin": stageNudge })}
                          onClick={() => {
                            pin({ appId: featured.appId, payload: featured.payload });
                            dispatchSplit({ type: "collapse" });
                            setOpen(false);
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M12 17v5M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
                          </svg>
                          Pin to dashboard
                        </button>
                      ) : null}
                    </div>
                    <div className="fl-stage-body">
                      <PayloadView
                        // Registrations come from the typed in-thread card
                        // (ThreadAppCard receives VendoViewPart payloads).
                        payload={featured.payload as UIPayload}
                        components={components}
                        onAction={({ action, payload: actionPayload }) =>
                          client.apps.call(featured.appId, action, actionPayload ?? {})}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="fl-stage-empty" role="status">
                    <p>Views you build land here.</p>
                    <p>Ask for a view in the conversation and it renders large on this stage.</p>
                  </div>
                )}
                {/* The build's own progress, under whatever the stage is
                    showing: the empty stage while the first view is still
                    being made, the view itself once it lands. */}
                <BeatRail beats={beats} />
                </>
              ) : null}
            </div>
            <div className="fl-split-rail" key="rail">
              <PrefillScopeContext.Provider value={prefillScope.current}>
                <Thread
                  key={`${conversationKey ?? 0}:${conversationEpoch}`}
                  discoverability={dial}
                  firstRunGreeting={greeting}
                  onThreadId={setPanelThreadId}
                />
              </PrefillScopeContext.Provider>
            </div>
          </div>
        </SplitViewContext.Provider>
      </div>
      {/* The embed's shared-element flight rides ABOVE the panel (the panel
          clips overflow, and mid-flight the ghost straddles both panes). */}
      {embedGhost ? (
        <EmbedMorphGhost
          key={embedGhost.id}
          from={embedGhost.from}
          target={embedGhost.target}
          clipTo={embedGhost.clipTo}
          clone={embedGhost.clone}
          mode={embedGhost.mode}
          onDone={() => setEmbedGhost(null)}
        />
      ) : null}
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
          // Keys the live-progress treatment (label swap + ring) in the sheet.
          {...(status.working ? { "data-vendo-run": "" } : {})}
          type="button"
          aria-expanded={open}
          aria-controls="vendo-overlay-dialog"
          // The button's NAME is pinned: the pill's text changes while a run
          // narrates, and a name that moves under the user's cursor (or their
          // voice command) is a worse trade than a name that stays the entry
          // point it always was. The beat is announced by the live region below.
          aria-label={launcherLabel ?? "AI agent"}
          onClick={() => setOpen(!open)}
        >
          <LauncherFace status={status} label={launcherLabel} {...(launcherConfig.icon === undefined ? {} : { icon: launcherConfig.icon })} />
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
      {/* The run finished while the user was elsewhere: one line, one way back
          into the conversation where the record sits (§3). Ignored, it
          withdraws and leaves the quiet dot. */}
      {!launcherHidden && status.toast !== undefined ? (
        <LauncherToast
          result={status.toast}
          position={launcherPosition}
          onView={status.view}
          onDismiss={status.dismissToast}
        />
      ) : null}
      {portal}
    </ChromeRoot>
  );
}
