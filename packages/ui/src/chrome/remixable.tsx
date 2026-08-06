import { isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { sha256Hex, type AppDocument, type Json, type TreeNode } from "@vendoai/core";
import { useVendoProvider } from "../context.js";
import { useApp } from "../hooks/use-app.js";
import { useResource } from "../hooks/use-resource.js";
import { FluidReveal } from "../tree/fluid-reveal.js";
import { AppFrame, PinMount } from "../tree/frames.js";
import type { InClientVenue, OpenSurface } from "../wire-types.js";
import { ChromeRoot } from "./chrome-root.js";
import { developmentMode } from "./dev-mode.js";
import { openVendoConversation } from "./overlay-registry.js";

/**
 * The remixable-surface affordance (2026-08-02 final shape): the host marking
 * one of its own components as forkable. Remix always means fork — the ✦
 * gesture executes the deterministic fork through the wire (the engine copies
 * the captured baseline; no model call, and the model never decides to fork),
 * and the user's fork mounts JAILED, IN PLACE, replacing the wrapped child at
 * this boundary for that user only.
 *
 * At rest a 9px muted ✦ seed sits inside the wrapped element's top-right
 * corner — visible if you look for it, invisible while you are working.
 * Pointing at the element blooms that seed IN PLACE into the ✦ pill — same
 * corner, same optical centre — so it reads as one mark opening rather than a
 * glyph swapping for a button. On an unforked surface the pill IS the fork
 * gesture; on a remixed one it opens the small management popover (status /
 * open in panel / revert).
 *
 * REVEALED IS STATE, NOT `:hover`. A CSS-only reveal dies the instant the
 * cursor leaves the box, which is exactly what it does on the way to the pill
 * — so the pill could never be clicked. One boolean instead, and pointer-leave
 * only clears it after a grace period the next pointer-enter cancels. Focus
 * reveals it the same way (focus and blur bubble on this div), so it stays
 * keyboard-reachable.
 */

/** Long enough for cursor travel from the element to the pill, short enough
 *  that the pill does not linger over the page. */
const GRACE_MS = 200;

const DISCOVERY_POLL_MS = 5000;

export interface RemixableProps {
  /** The review-kind flag (capture metadata — sync writes it into the
   *  baseline). Review buys the venue, never visibility: a reviewed
   *  component's approved fork mounts natively; an instant (default) one
   *  renders sandboxed, forever, with no review process at all. The gating
   *  itself is server-side — here it only shapes the popover's status line. */
  review?: boolean;
  children: ReactNode;
}

/** The slot name is the wrapped component's identifier — the same exported
 *  name `vendo sync` captures the baseline under. Inline JSX or a plain
 *  element is a loud sync-time error, so at runtime it simply gets no
 *  affordance.
 *
 *  MINIFICATION: a production bundle erases `Function.name`, so a wrapped
 *  component must carry React's canonical `displayName` (set to its exported
 *  identifier) for the affordance to exist in production builds — dev always
 *  resolves, which is exactly why the gap is easy to miss. Flagged to the
 *  driving session for sync-time enforcement. */
function slotOf(children: ReactNode): string | null {
  if (!isValidElement(children) || typeof children.type === "string") return null;
  const type = children.type as { displayName?: string; name?: string };
  const name = type.displayName ?? type.name ?? "";
  return /^[A-Z]/.test(name) ? name : null;
}

/** JSON-serializable check for the fork's props snapshot. Functions, elements,
 *  symbols, and class instances (Dates included) are dropped SILENTLY: host
 *  functions never cross the frame boundary — behavior is rewired through the
 *  host's API instead. */
const isSerializable = (value: unknown): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSerializable);
  if (typeof value === "object") {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value).every(isSerializable);
  }
  return false;
};

/** The wrapper's serializable live props — the fork call's `props` payload
 *  (stored server-side as the fork's dashboard seed) and what flows into the
 *  mounted fork on every render. */
function serializableProps(children: ReactNode): Record<string, Json> {
  if (!isValidElement(children)) return {};
  const props = children.props as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(props).filter(([, value]) => isSerializable(value)),
  ) as Record<string, Json>;
}

/** Structural copy of @vendoai/apps' pinComponentName (ui depends on core
 *  only — the JailFurnishing precedent): the stable generated-component name
 *  a fork ships under, needed to find the pinned node in the fork's tree. */
const pinComponentName = (slot: string): string => {
  const stem = (slot.match(/[A-Za-z0-9]+/g) ?? [])
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("") || "Slot";
  return `Pinned${stem}${sha256Hex(slot).slice(0, 8)}`;
};

const NO_APPS: AppDocument[] = [];

/** Fork discovery: the user's fork for this slot is the app whose `pins` name
 *  it (provenance — the 2026-08-02 pins/placements split). An in-place fork
 *  needs no placement: its location IS the wrapper it replaced, so this reads
 *  pins, never placements.
 *
 *  The OLDEST matching row wins, and deliberately: `.at(-1)` over a newest-first
 *  list is the same winner the SERVER's fork-pin dedupe converges on (runtime.ts
 *  — "the OLDEST matching row, so every dedupe path converges"). Newest-wins
 *  here would put the wrapper and the server on different apps whenever a slot
 *  somehow carries two. (This comment used to say "latest wins, like slot
 *  discovery"; slot discovery genuinely meant latest and was reading the oldest
 *  — see use-slot-app.ts. Here the code was right and the comment was wrong.) */
function useRemixFork(slot: string | null) {
  const { client } = useVendoProvider();
  const list = useCallback(
    () => (slot === null ? Promise.resolve(NO_APPS) : client.apps.list()),
    [client, slot],
  );
  const { data, refresh } = useResource(list, NO_APPS, { pollMs: slot === null ? 0 : DISCOVERY_POLL_MS });
  const appId = data.filter(app => app.pins?.some(pin => pin.slot === slot)).at(-1)?.id;
  return { appId, refresh };
}

/** The popover's status line, read straight off the open payload — the venue
 *  verdict is SERVER-authoritative (lane W1c owns the review lifecycle; this
 *  only renders what the payload reports). */
function remixStatus(review: boolean, surface: OpenSurface | undefined): string {
  if (!review) return "Sandboxed — only you see this";
  if (surface?.kind === "failed") return surface.reason;
  if (surface?.kind !== "tree") return "Waiting for review";
  const venue = (surface.payload as { inClient?: InClientVenue }).inClient;
  if (venue?.granted === true) {
    // An older approved version can be serving while the CURRENT one awaits
    // review (the `review` rider) — the status reports BOTH, or it would hide
    // the pending state and the reviewer's note behind "Approved".
    const serving = `Approved by ${venue.approvedBy} — runs in the page`;
    if (venue.review?.status === "pending") return `${serving}; your latest edit is waiting for review`;
    if (venue.review?.status === "rejected") return `${serving}; your latest edit was rejected — "${venue.review.note}"`;
    return serving;
  }
  if (venue?.granted === false && venue.reason === "pending-review" && venue.review.status === "rejected") {
    return `Rejected — "${venue.review.note}". Edit the remix to resubmit it for review.`;
  }
  if (venue?.granted === false && venue.reason === "version-changed") {
    return "Changed since approval — sandboxed until re-approved";
  }
  return "Waiting for review";
}

function RemixedFork({ appId, slot, review, liveProps, menuOpen, onMenuToggle, original, onReverted }: {
  appId: string;
  slot: string;
  review: boolean;
  liveProps: Record<string, Json>;
  menuOpen: boolean;
  onMenuToggle(open: boolean): void;
  original: ReactNode;
  onReverted(): Promise<void>;
}) {
  const { client, components } = useVendoProvider();
  const { surface, error, isLoading } = useApp(appId);
  const menuRef = useRef<HTMLDivElement>(null);
  const [reverting, setReverting] = useState(false);

  // The popover dismisses like any menu: Escape, or pointer-down outside it.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) onMenuToggle(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onMenuToggle(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen, onMenuToggle]);

  useEffect(() => {
    if (!isLoading && error !== undefined && developmentMode()) {
      console.warn(`[vendo] Remixable "${slot}": the fork failed to load — ${error.message}`);
    }
  }, [error, isLoading, slot]);

  // Live serializable props from the call site flow into the mounted fork on
  // every render (final-shape data route 1: nothing captured, nothing stale) —
  // they override the fork-time seed on the pinned node; props an edit set
  // that the call site does not pass survive underneath. Keyed on content so
  // an unchanged call site never re-stages the payload.
  const livePropsKey = JSON.stringify(liveProps);
  const staged = useMemo(() => {
    if (surface?.kind !== "tree") return surface;
    const payload = structuredClone(surface.payload);
    const nodes = payload.nodes as TreeNode[] | undefined;
    const pinned = nodes?.find(node => node.component === pinComponentName(slot) && node.source === "generated");
    if (pinned) pinned.props = { ...pinned.props, ...(JSON.parse(livePropsKey) as Record<string, Json>) };
    return { ...surface, payload };
  }, [surface, slot, livePropsKey]);

  const revert = () => {
    if (reverting) return;
    setReverting(true);
    client.apps.delete(appId)
      .then(() => {
        onMenuToggle(false);
        return onReverted();
      })
      .catch((reason: unknown) => {
        if (developmentMode()) {
          console.warn(`[vendo] Remixable "${slot}": revert failed — ${reason instanceof Error ? reason.message : String(reason)}`);
        }
      })
      .finally(() => setReverting(false));
  };

  // The founder's binding rule (2026-08-02): until a reviewer approves, the
  // ORIGINAL host component stays rendered, untouched. A pending or rejected
  // review-kind remix mounts NOTHING here — no AppFrame, no notice in the
  // page; its status lives in the panel and the ✦ popover. The venue verdict
  // is server-authoritative ("pending-review" ships no executable source);
  // the wrapper's own `review` flag covers a payload that carries no venue.
  const venue = surface?.kind === "tree" ? (surface.payload as { inClient?: InClientVenue }).inClient : undefined;
  const underReview = venue?.granted !== true
    && (review || (venue !== undefined && !venue.granted && venue.reason === "pending-review"));

  // Until the fork's surface arrives (or if it never does), the original child
  // is the honest content — the wrapper never trades working host markup for
  // a skeleton, and a crashing fork drops back to it (PinMount).
  const Original = () => <>{original}</>;
  return (
    <>
      {staged?.kind === "tree" && !underReview ? (
        <ChromeRoot>
          <FluidReveal stateKey={`fork:${appId}`} initialExit={original}>
            <PinMount slot={slot} fallback={Original}>
              <AppFrame
                surface={staged}
                components={components}
                onAction={({ action, payload }) => client.apps.call(appId, action, payload ?? {})}
              />
            </PinMount>
          </FluidReveal>
        </ChromeRoot>
      ) : original}
      <ChromeRoot className="fl-remixable-chrome">
        <span className="fl-remix-seed" aria-hidden="true">✦</span>
        <div className="fl-remix-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="fl-remix-pill"
            aria-label={`Manage the ${slot} remix`}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            onClick={() => onMenuToggle(!menuOpen)}
          >
            <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
            Remixed
          </button>
          {menuOpen ? (
            <div className="fl-remix-menu" role="group" aria-label={`Remix of ${slot}`}>
              <span className="fl-remix-status" role="status">{remixStatus(review, surface)}</span>
              <button
                type="button"
                onClick={() => {
                  onMenuToggle(false);
                  // The prefill names the THING, never an id (spec §16 law 3):
                  // it used to read "Update my <slot> remix (app app_…): " and
                  // an app id is our plumbing, not something a person types.
                  // The agent's app tools are appId-keyed with no list tool, so
                  // the grounding rides `context` — a marked text part on the
                  // sent message that no surface renders.
                  const opened = openVendoConversation({
                    prompt: `Update my ${slot} remix: `,
                    context: `The view being remixed is the "${slot}" slot, app ${appId}.`,
                    send: false,
                  });
                  if (!opened && developmentMode()) {
                    console.warn(`[vendo] Remixable "${slot}": "Open in panel" opens the conversation surface — mount a VendoOverlay for it to land in.`);
                  }
                }}
              >
                Open in panel
              </button>
              <button type="button" className="is-danger" disabled={reverting} onClick={revert}>
                {reverting ? "Reverting…" : "Revert to original"}
              </button>
            </div>
          ) : null}
        </div>
      </ChromeRoot>
    </>
  );
}

export function Remixable({ review = false, children }: RemixableProps) {
  const { client } = useVendoProvider();
  const [revealed, setRevealed] = useState(false);
  const grace = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(grace.current), []);

  const slot = slotOf(children);
  const { appId, refresh } = useRemixFork(slot);

  // The management popover's open state lives HERE so it can hold the bloom:
  // closing the reveal on pointer-leave would rip the popover out from under
  // the cursor.
  const [menuOpen, setMenuOpen] = useState(false);

  // The gesture latch. The ref (not state) is the double-fire guard — a second
  // synchronous tap can never mint a second call, and the server's
  // per-(subject, slot) dedupe makes even a raced duplicate return the same
  // app. State only drives the label, and holds until the fork surfaces.
  const forking = useRef(false);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (appId !== undefined) setLatched(false);
  }, [appId]);

  useEffect(() => {
    if (slot === null && developmentMode()) {
      console.warn("[vendo] <Remixable> must wrap exactly one statically importable component element; extract a component and wrap that (vendo sync says the same, loudly).");
    }
  }, [slot]);

  if (slot === null) return <>{children}</>;

  const reveal = () => {
    window.clearTimeout(grace.current);
    setRevealed(true);
  };
  const release = () => {
    window.clearTimeout(grace.current);
    grace.current = window.setTimeout(() => setRevealed(false), GRACE_MS);
  };

  // Gesture-owned forking (2026-07-21, the unchanged trust foundation): the ✦
  // gesture executes the deterministic fork through the wire, carrying the
  // wrapper's serializable live props as the fork's seed. No model call — and
  // nothing here can fire a turn.
  const fork = () => {
    if (forking.current || appId !== undefined) return;
    forking.current = true;
    setLatched(true);
    client.apps.forkPin({ slot, props: serializableProps(children) })
      .then(() => refresh())
      .catch((reason: unknown) => {
        setLatched(false);
        if (developmentMode()) {
          console.warn(`[vendo] Remixable "${slot}": the remix fork failed — ${reason instanceof Error ? reason.message : String(reason)}`);
        }
      })
      .finally(() => {
        forking.current = false;
      });
  };

  return (
    // data-vendo-remixable marks the element's real boundary: the fork's mount
    // point, and where a pin's ghost flies back into.
    <div
      className="fl-remixable"
      data-vendo-remixable={slot}
      {...(revealed || latched || menuOpen ? { "data-vendo-revealed": "" } : {})}
      onPointerEnter={reveal}
      onPointerLeave={release}
      onFocus={reveal}
      onBlur={release}
    >
      {appId !== undefined ? (
        <RemixedFork
          appId={appId}
          slot={slot}
          review={review}
          liveProps={serializableProps(children)}
          menuOpen={menuOpen}
          onMenuToggle={setMenuOpen}
          original={children}
          onReverted={refresh}
        />
      ) : (
        <>
          {children}
          <ChromeRoot className="fl-remixable-chrome">
            <span className="fl-remix-seed" aria-hidden="true">✦</span>
            <button
              type="button"
              className="fl-remix-pill"
              aria-label={`Remix ${slot} with Vendo`}
              aria-busy={latched || undefined}
              disabled={latched}
              onClick={fork}
            >
              <span aria-hidden="true" className="fl-remix-pill-mark">✦</span>
              {latched ? "Remixing…" : "Remix"}
            </button>
          </ChromeRoot>
        </>
      )}
    </div>
  );
}
