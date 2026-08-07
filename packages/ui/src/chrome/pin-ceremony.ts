/**
 * The pin payoff: a ghost of the card being pinned glides into the slot it
 * lands in, and the slot takes one settle pulse.
 *
 * A pin used to be silent — the panel stayed open over the page, and the slot
 * showed the app whenever its next poll happened to fire (up to five seconds
 * later). Nothing connected the click to the result. This is that connection,
 * and it is presentation only: the real pin is the host's `onPin` write plus
 * the slot's own read, so a missing destination means no animation rather than
 * a stranded ghost.
 *
 * THE PANEL IS GONE BEFORE ANYTHING MOVES. A pin's whole point is what appears
 * on the page, and the card being pinned sits in a centred panel over a scrim —
 * so the flight would otherwise play behind the very thing hiding it. The order
 * is: lift the ghost off the panel, dismiss the panel, then measure and fly over
 * the bare page.
 *
 * Plain DOM + Web Animations API on purpose: every element and keyframe here is
 * created per call and removed when it finishes, so nothing lands in the chrome
 * stylesheet. Fixed durations, no randomness — the same 480ms every run.
 *
 * Lifted from the Keystone demo's `pin-flight.ts`, which is where the sequence
 * was designed and proven on stage.
 */
import { useCallback, useEffect, useState } from "react";
import { useVendoProvider } from "../context.js";
import { announcePin, onPinAnnounced, pinTaken } from "../pin-events.js";
import { openVendoConversation } from "./overlay-registry.js";
import { developmentMode } from "./dev-mode.js";
import { vendoToast } from "./vendo-toasts.js";

/** 300 + 180 = 480ms end to end (the design budget is "under half a second"). */
const FLIGHT_MS = 300;
const PULSE_MS = 180;
/** A ~4% overshoot that settles — a spring, not a bounce. */
const SETTLE = "cubic-bezier(0.32, 1.04, 0.36, 1)";
const FADE_MS = 110;
/** `.fl-overlay-panel` sits at 2147483001 and the card flies OUT of it, so the
 *  ghost and the ring have to clear it. */
const ABOVE_OVERLAY = "2147483002";
/** A slot is often a short banner while the source card is a tall panel; fitting
 *  both axes would shrink the ghost to an unreadable speck. */
const MIN_GHOST_SCALE = 0.34;
/** The destinations that are OURS rather than the host's page — the Apps shelf,
 *  live or day-zero. They are themed, so the ring lands in the accent. */
const OUR_CHROME = ".fl-shelf";

export interface PinCeremonyOptions {
  /** The app being pinned — its in-thread card is the ghost's source. */
  appId: string;
  /** The slot it lands in. Omitted, the ceremony aims at the only mounted
   *  VendoSlot; with several mounted and no id there is no way to know, so the
   *  panel still dismisses and nothing flies. */
  slot?: string;
  /** Dismiss the surface the card is in. Called ONCE, after the ghost is clear
   *  and before anything is measured — so a pin dismisses the panel even when
   *  there is no animation to play. */
  dismiss?(): void;
}

/** Rect of an element that is actually laid out — an unmounted or hidden
 *  destination measures 0 and is treated as absent. */
function boxOf(element: Element | null): DOMRect | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

/** The destination the pin lands in — a mounted VendoSlot, or a `<Remixable>`
 *  wrapper (the fork's in-place mount boundary, 2026-08-02 final shape). A
 *  named destination is exact; unnamed, the only mounted one is unambiguous
 *  and every host with one dashboard slot gets the ceremony for free. Host
 *  slots keep priority; with none resolvable the Apps shelf is the floor. */
function destinationOf(slot: string | undefined): Element | null {
  // Matched by attribute VALUE rather than an interpolated selector: slot and
  // app ids come from the host, and a quote in one would break the selector.
  const mounted = [...document.querySelectorAll("[data-vendo-slot], [data-vendo-remixable]")];
  const named = slot === undefined
    ? (mounted.length === 1 ? mounted[0]! : null)
    : mounted.find(element =>
      element.getAttribute("data-vendo-slot") === slot || element.getAttribute("data-vendo-remixable") === slot,
    ) ?? null;
  // No slot resolved — none mounted, or several with no name to choose by. This
  // used to return null, and since the dismiss had already fired the user's pin
  // appeared to VANISH: no flight, no ring, nothing. The Apps shelf is where a
  // pinned app shows up, so it is where the pin lands. The day-zero ghost shelf
  // is the last resort: it advertises what to build and holds no apps.
  return named
    ?? document.querySelector(`${OUR_CHROME}:not(.fl-shelf--ghost)`)
    ?? document.querySelector(OUR_CHROME);
}

/**
 * The settle ring's shadow.
 *
 * A HOST SLOT gets a crisp hairline in the slot's OWN `color`: it is a small,
 * defined region in someone else's page, the line reads as "here", and
 * borrowing the ink is what makes a pin look like it belongs to the host.
 *
 * OUR OWN Apps shelf gets a soft bloom instead, because the same treatment drew
 * a debug border around it. Two things had to change, and the first alone was
 * not enough: the shelf's `color` is body text (so the ring was inked in body
 * text), AND a full-strength hairline around a WIDE band reads as a border
 * whatever its hue — this theme's accent is itself near-black, so switching
 * token changed almost nothing on screen. A wide destination takes a glow.
 */
function ringShadow(destination: Element, style: CSSStyleDeclaration): string {
  if (!destination.matches(OUR_CHROME)) {
    return `0 0 0 1.5px ${style.color}, 0 12px 40px -14px ${style.color}`;
  }
  const accent = style.getPropertyValue("--vendo-accent").trim() || style.color;
  return `0 0 0 3px color-mix(in srgb, ${accent} 16%, transparent),`
    + ` 0 10px 34px -12px color-mix(in srgb, ${accent} 40%, transparent)`;
}

/** The settle pulse: a ring drawn OVER the destination, never a style written
 *  onto it — this module animates surfaces it does not own. */
function pulse(destination: Element): void {
  const box = boxOf(destination);
  if (box === null) return;
  const style = getComputedStyle(destination);
  const ring = document.createElement("div");
  ring.setAttribute("data-vendo-pin-ring", "");
  ring.setAttribute("aria-hidden", "true");
  Object.assign(ring.style, {
    position: "fixed",
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: style.borderRadius,
    boxShadow: ringShadow(destination, style),
    pointerEvents: "none",
    zIndex: ABOVE_OVERLAY,
  });
  document.body.append(ring);
  const fade = ring.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], {
    duration: PULSE_MS,
    easing: "ease-out",
  });
  fade.onfinish = () => ring.remove();
}

/**
 * A themed home for the ghost that OUTLIVES the panel it flew out of.
 *
 * The clone keeps its look from the chrome stylesheet, but the theme's
 * `--vendo-*` variables live inline on the nearest `.vendo-root` — and the
 * obvious parent, the card's own root, is the overlay's, which the dismiss
 * hides. So this hand-rolls the same boundary on document.body (what
 * ChromeRoot does for anything portalled out of it): copy the source root's
 * inline declaration onto a zero-size fixed box. Zero-size paints nothing and
 * takes no layout, and a fixed child is positioned against the viewport
 * whatever its ancestors are, so the ghost's captured coordinates still mean
 * what they meant inside the panel.
 */
function ghostStage(source: Element): HTMLElement {
  const themed = source.closest(".vendo-root");
  const stage = document.createElement("div");
  stage.className = "vendo-root";
  stage.setAttribute("data-vendo-pin-stage", "");
  stage.setAttribute("aria-hidden", "true");
  if (themed instanceof HTMLElement) stage.style.cssText = themed.style.cssText;
  Object.assign(stage.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    pointerEvents: "none",
    zIndex: ABOVE_OVERLAY,
  });
  document.body.append(stage);
  return stage;
}

/** The clone, parked over the card it copied, in a parent that survives the
 *  dismiss. Measured here because the panel is still on screen. */
function liftGhost(source: Element, from: DOMRect): { ghost: HTMLElement; stage: HTMLElement } {
  const ghost = source.cloneNode(true) as HTMLElement;
  ghost.setAttribute("data-vendo-pin-ghost", "");
  ghost.setAttribute("aria-hidden", "true");
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    transformOrigin: "top left",
    pointerEvents: "none",
    zIndex: ABOVE_OVERLAY,
  });
  const stage = ghostStage(source);
  stage.append(ghost);
  return { ghost, stage };
}

function fly(
  lifted: { ghost: HTMLElement; stage: HTMLElement },
  from: DOMRect,
  to: DOMRect,
  destination: Element,
): void {
  const { ghost, stage } = lifted;
  const scale = Math.max(MIN_GHOST_SCALE, Math.min(1, to.width / from.width, to.height / from.height));
  const dx = to.left + (to.width - from.width * scale) / 2 - from.left;
  const dy = to.top + (to.height - from.height * scale) / 2 - from.top;
  const flight = ghost.animate(
    [
      { transform: "translate(0px, 0px) scale(1)" },
      { transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
    ],
    { duration: FLIGHT_MS, easing: SETTLE, fill: "forwards" },
  );
  // Its own animation so the flight keeps its easing: the ghost holds at full
  // strength and only dissolves on arrival, as the ring takes over.
  ghost.animate([{ opacity: 0.92 }, { opacity: 0 }], {
    duration: FADE_MS,
    delay: FLIGHT_MS - FADE_MS,
    easing: "linear",
    fill: "both",
  });
  flight.onfinish = () => {
    stage.remove();
    pulse(destination);
  };
}

/** Play the pin ceremony. Reduced motion keeps the dismiss and the settle pulse
 *  and skips the flight — the fade is the whole movement. Safe to call anywhere:
 *  without a DOM (SSR) or the Web Animations API it just dismisses. */
export function playPinCeremony({ appId, slot, dismiss = () => {} }: PinCeremonyOptions): void {
  if (typeof document === "undefined" || typeof Element.prototype.animate !== "function") {
    dismiss();
    return;
  }
  const source = [...document.querySelectorAll("[data-vendo-app-embed]")]
    .find(element => element.getAttribute("data-vendo-app-embed") === appId) ?? null;
  const from = boxOf(source);
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Nothing on the page to land in — no host slot and no Apps shelf. The
  // check below at measure time catches this too, but only AFTER the ghost has
  // lifted, so the pin read as a flight into thin air. Skip the ceremony
  // instead: the pin itself still happens, it just does not animate.
  if (destinationOf(slot) === null) {
    dismiss();
    return;
  }
  const lifted = source !== null && from !== null && !reduced ? liftGhost(source, from) : null;

  dismiss();

  // TWO FRAMES, then measure. Dismissing is a React state change, so on this
  // tick the panel is still in the DOM and the destination's rect is still the
  // one from behind a scrim — and closing releases the body scroll lock, which
  // can move it. rAF×2 is ~32ms against a 480ms budget (invisible), and it is
  // what makes the payoff play over the bare page.
  requestAnimationFrame(() => {
    // Bring the slot on screen BEFORE measuring, in the frame the scroll lock
    // is released: the panel is a modal over a page the user may have scrolled
    // away from its slot, and a flight to somewhere above the fold shows them
    // nothing. `nearest` is a no-op when the slot is already visible.
    // (jsdom leaves scrollIntoView undefined; browsers always have it.)
    const landing = destinationOf(slot);
    if (landing && typeof landing.scrollIntoView === "function") {
      landing.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    requestAnimationFrame(() => {
      const destination = destinationOf(slot);
      const to = boxOf(destination);
      if (destination === null || to === null) {
        lifted?.stage.remove();
        return;
      }
      if (lifted === null || from === null) {
        pulse(destination);
        return;
      }
      fly(lifted, from, to, destination);
    });
  });
}

/** Every pin affordance's one path: ceremony, then the host's write, then the
 *  announcement that lets the slot show the result without waiting for a poll.
 *  Returns undefined when the host wired no `onPin` — which is what hides the
 *  affordances in the first place. */
/**
 * The pin affordance's nudge state (mockup 2026-08-04): a settled build whose
 * pin has not been taken INVITES it with a quiet infinite pulse, and the moment
 * it is taken the affordance resolves to a settled accent state. `undefined` is
 * the quiet default.
 *
 * "Not taken yet" is the pin bus, NOT a placements read: placements live on the
 * app document, which no pin affordance holds, so knowing it for certain costs a
 * list fetch per card — a request to render one boolean. The honest cost of that
 * choice is that a pin made in an earlier session invites once more.
 *
 * `invited` is the CALLER's — whether this surface's build just landed (the
 * in-thread card is `restored === false`) — because only the caller knows.
 */
export function usePinNudge(appId: string, invited: boolean): "invite" | "pinned" | undefined {
  const [taken, setTaken] = useState(() => pinTaken(appId));
  useEffect(() => {
    setTaken(pinTaken(appId));
    return onPinAnnounced(pinned => {
      if (pinned === appId) setTaken(true);
    });
  }, [appId]);
  if (taken) return "pinned";
  return invited ? "invite" : undefined;
}

/**
 * Every pin affordance's one path: ceremony, THEN the placement write, then
 * the announcement that lets every mounted slot show the result without
 * waiting for a poll, then the host's optional `onPin`.
 *
 * The write is Vendo's now (2026-08-05): a pin is `apps.place`, awaited, so
 * "the app is in the slot" is true before anything is announced. `onPin`
 * survives as a side-effect seam for hosts that mirror the pin into their own
 * product state — it is no longer what makes a pin happen, and a host that
 * wires only `pinSlot` gets the whole feature with no server code at all.
 *
 * Returns undefined when the host wired NEITHER — which is what hides the
 * affordances in the first place.
 */
export function usePinAction(): ((app: { appId: string; payload: unknown }) => void) | undefined {
  // `useVendoProvider` since #852 — the file already imports it under that name.
  const { client, onPin, pinSlot } = useVendoProvider();
  const pin = useCallback(
    (app: { appId: string; payload: unknown }) => {
      playPinCeremony({
        appId: app.appId,
        ...(pinSlot === undefined ? {} : { slot: pinSlot }),
        dismiss: () => void openVendoConversation({ close: true }),
      });
      void (async () => {
        if (pinSlot !== undefined) {
          try {
            await client.apps.place(app.appId, pinSlot);
          } catch (reason) {
            // Nothing was written, so nothing downstream may say otherwise:
            // announcing settles every pin affordance into its pinned state and
            // sends every mounted slot to re-read a placement that does not
            // exist, and `onPin` is the host mirroring a pin that never
            // happened. One honest line instead — the same sentence the
            // "Add to…" picker shows when its own `apps.place` is refused. A
            // toast because this path's surface is already dismissed by the
            // time the write answers, so there is nowhere inline left to say it.
            if (developmentMode()) {
              console.warn(`[vendo] pin: placing ${app.appId} in "${pinSlot}" failed — ${String(reason)}`);
            }
            vendoToast({ text: "That didn’t go through — try again.", state: "error" });
            return;
          }
        }
        announcePin(app.appId);
        onPin?.(app);
      })();
    },
    [client, onPin, pinSlot],
  );
  return pinSlot === undefined && onPin === undefined ? undefined : pin;
}
