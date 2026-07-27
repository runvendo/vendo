import React, {createContext, useContext} from 'react';
import {VendoOverlay} from '../../../../packages/ui/src/chrome/vendo-overlay';

/**
 * The REAL product panel, film-positioned.
 *
 * The panel on camera is `VendoOverlay` → `.fl-overlay-panel` from
 * `packages/ui/src/chrome/vendo-overlay.tsx`: the product's glass frame, its
 * border, radius and shadow, and its real header controls (new conversation,
 * expand workspace, close). Nothing about the panel is drawn by the film.
 *
 * The film supplies exactly three things:
 *
 *  1. **The conversation body**, through the overlay's own sanctioned injection
 *     point — the `thread` prop ("the eject seam: a thread component the panel
 *     renders in place of the built-in `VendoThread`. The overlay stays the
 *     positioning shell"). The built-in thread drives itself from the live
 *     transport, which the film deliberately has no wire for; the film's thread
 *     renders the real `MessageList` off frame-derived messages.
 *  2. **Geometry** (`panelGeometryCss`). The panel is `position: fixed` and
 *     portals to `document.body`; Remotion's viewport IS the 1920x1080 film
 *     frame, so fixed coordinates ARE film coordinates. The override states the
 *     rect the pinned transitions were authored against — OrbWhip lands at
 *     `DOT`, WidgetFlight lifts from `WIDGET`, both derived from `CARD` — and
 *     nothing else about the panel's appearance.
 *  3. **Motion.** Every wall-clock CSS animation and transition inside the real
 *     components is switched off (`STILL_CSS`), because Remotion steps frames:
 *     the product's `.5s fl-overlay-stretch` open, the `.fl-msglist-wrap`
 *     fade-in, the app-card's looping build sweep and the expand button's
 *     suggest pulse would all make a render non-reproducible. The film's
 *     frame-driven springs replace them.
 *
 * The product's panel has no title row: its header is the control cluster
 * above. The prototype drew an "Assistant" header row with a violet status dot;
 * that was an invention and is gone. The orb whip's landing frame and
 * coordinates are unchanged — it now condenses onto the real panel's own
 * top-left corner as the panel springs up underneath it.
 */

const ThreadBodyContext = createContext<React.ReactNode>(null);

/** Stable component identity: the overlay keys the thread's mount on it, so a
 *  per-frame closure would remount the real components on every frame. */
const ThreadSlot: React.FC = () => <>{useContext(ThreadBodyContext)}</>;

/**
 * The studio's one blanket rule over real-component motion. Remotion renders by
 * stepping a frame counter, not by letting time pass, so any wall-clock
 * animation or transition inside a real component is captured at whatever phase
 * the render process happens to be in — the definition of a non-reproducible
 * render. Scoped to the chrome's own theme boundaries, documented here, and
 * never applied to the film's own (frame-driven) motion.
 */
export const STILL_CSS = `
.vendo-root, .vendo-root *, .fl-overlay-portal, .fl-overlay-portal * {
  animation: none !important;
  transition: none !important;
}`;

export interface PanelGeometry {
  /** The panel rect in film coordinates. */
  rect: {x: number; y: number; w: number; h: number};
  /** The film's slide-up offset (panelRise). */
  rise: number;
  /** The scene camera scale. `CARD` is screen-centred, so scaling the panel
   *  about its own centre is identical to the scene's centre-origin scale. */
  cam: number;
  /** Scene opacity, for the fade-back under the incoming dashboard. */
  opacity: number;
  /** 0..1 — how much the panel is in motion, which deepens its shadow. */
  motion: number;
}

/**
 * The scoped geometry override. Emitted every frame from the frame number, so
 * the panel's position stays a pure function of the frame.
 *
 * The shadow keeps the product's own values (`0 30px 80px` of 28% foreground)
 * and only rides the film's deepen-while-moving rule on top of them.
 */
export const panelGeometryCss = ({
  rect,
  rise,
  cam,
  opacity,
  motion,
}: PanelGeometry): string => `
.fl-overlay-panel {
  left: ${rect.x}px; top: ${rect.y}px;
  width: ${rect.w}px; height: ${rect.h}px;
  transform: translateY(${rise}px) scale(${cam});
  transform-origin: center;
  opacity: ${opacity};
  box-shadow: 0 ${30 + 12 * motion}px ${80 + 24 * motion}px
    color-mix(in srgb, var(--vendo-fg) ${28 + 8 * motion}%, transparent);
}
/* The modal scrim exists to dim a HOST PAGE behind the panel. The film
   composites the panel over its own scenes (and over the dashboard it later
   reveals), so the scrim has nothing to dim and would only grey the film. */
.fl-overlay-scrim { display: none; }
/* The film has no scroll viewport: it moves the transcript itself, on the beat.
   Layout-only concessions — no product colour, type or spacing is touched. */
.fl-msglist { overflow: visible; -webkit-mask-image: none; mask-image: none; }
.fl-msglist > :first-child { margin-top: 0; }
`;

export const OverlayPanel: React.FC<
  PanelGeometry & {children: React.ReactNode}
> = ({children, ...geometry}) => (
  <>
    <style>{STILL_CSS + panelGeometryCss(geometry)}</style>
    <ThreadBodyContext.Provider value={children}>
      <VendoOverlay open launcher="none" thread={ThreadSlot} />
    </ThreadBodyContext.Provider>
  </>
);
