import type React from 'react';
import {interpolate, spring} from 'remotion';

export const C = {
  bg: '#FAFAFA',
  white: '#FFFFFF',
  violet: '#6C3BFF',
  lilac: '#A78BFA',
  ink: '#0E0B1A',
  body: '#3A3546',
  muted: '#8B879B',
  border: 'rgba(14,11,26,0.06)',
  softFill: '#F2F0F7',
  barFill: '#EEECF4',
};

/**
 * Film layers, above the real product panel.
 *
 * `VendoOverlay`'s panel portals to `document.body` and carries the product's
 * own `z-index: 2147483001` (chrome-css.ts) — it has to beat any host page it
 * opens over. The film draws over that panel (the orb whips onto it, the widget
 * flies off it, the cursor moves across it), so its layers are offsets from that
 * number. The relative order is exactly the prototype's: cursor, then widget
 * flight, then orb whip, then the detonation on top of everything.
 */
const PANEL_Z = 2147483001;
export const FILM_Z = {
  cursor: PANEL_Z + 1,
  flight: PANEL_Z + 2,
  whip: PANEL_Z + 3,
  detonation: PANEL_Z + 4,
} as const;

export const SPRING_CFG = {damping: 14, stiffness: 120, mass: 0.8};

// Spring snap-in helper. Returns spring value s (with overshoot) and opacity o.
export const snap = (frame: number, fps: number, start: number) => {
  if (frame < start) return {s: 0, o: 0};
  const s = spring({frame: frame - start, fps, config: SPRING_CFG});
  const o = interpolate(frame - start, [0, 4], [0, 1], {
    extrapolateRight: 'clamp',
  });
  return {s, o};
};

// Standard snap transform: slight rise + scale overshoot.
export const snapStyle = (
  s: number,
  o: number,
  rise = 28,
): React.CSSProperties => ({
  opacity: o,
  transform: `translateY(${(1 - s) * rise}px) scale(${0.85 + 0.15 * s})`,
});

// Global camera law: every scene gets a continuous subtle push-in.
export const pushIn = (frame: number, dur: number, from = 1, to = 1.03) => {
  const t = Math.min(Math.max(frame / dur, 0), 1);
  return from + (to - from) * t;
};

