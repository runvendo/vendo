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

export const cardStyle: React.CSSProperties = {
  backgroundColor: C.white,
  borderRadius: 12,
  boxShadow: '0 4px 24px rgba(108,59,255,0.10)',
  border: `1px solid ${C.border}`,
};

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

// Card shadow that deepens ~30%+ while the card is in motion (motion 0..1).
export const cardShadow = (motion = 0) =>
  `0 ${4 + 10 * motion}px ${24 + 14 * motion}px rgba(108,59,255,${
    0.1 + 0.07 * motion
  })`;
