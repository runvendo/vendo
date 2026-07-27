import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, FILM_Z, pushIn} from './theme';
import {
  CHAT_START,
  DOT,
  DOT_HANDOFF,
  panelRise,
} from './chatShared';

// MATCH CUT, eruption → chat. Global-frame overlay. The orb (having absorbed
// all chips) whips toward the top-left and SHRINKS into the violet
// "Assistant" status dot of the chat panel — one continuous shared-element
// move with motion blur along the axis during the whip. The panel slides up
// underneath; the overlay tracks the panel spring so orb and dot are the
// same object, then hands the dot to the panel at DOT_HANDOFF.

const ORB = {x: 1290, y: 430};
const ORB_SCALE = 1.45; // all 34 chips absorbed
const BASE = 150;

const START = 68; // eruption hides its orb here (local 50)
const WHIP0 = 71;
const WHIP1 = 79;
const END = CHAT_START + DOT_HANDOFF; // 87

export const OrbWhip: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < START || frame >= END) return null;

  // The eruption scene runs a push-in; mirror it so the overlay orb sits
  // exactly where the (hidden) scene orb would be. Freeze once the scene ends.
  const sc = pushIn(Math.min(frame - 18, 57), 57);
  const srcX = 960 + (ORB.x - 960) * sc;
  const srcY = 540 + (ORB.y - 540) * sc;

  // Live target: the header dot of the chat panel, riding the panel spring.
  const local = frame - CHAT_START;
  const rise = panelRise(local, fps);
  const dotX = DOT.x;
  const dotY = DOT.y + rise;

  const p = interpolate(frame, [WHIP0, WHIP1], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Curved whip: control point arcs up and left.
  const ctrlX = (srcX + dotX) / 2 - 60;
  const ctrlY = Math.min(srcY, dotY) - 190;
  const u = 1 - p;
  const x = u * u * srcX + 2 * u * p * ctrlX + p * p * dotX;
  const y = u * u * srcY + 2 * u * p * ctrlY + p * p * dotY;

  // Radius: keep orb-sized through the launch, shrink hard on approach.
  const r = interpolate(p, [0, 0.5, 1], [(BASE / 2) * ORB_SCALE * sc, 64, 6]);

  // Motion blur along the motion axis during the fastest 2 frames.
  const pPrev = interpolate(frame - 1, [WHIP0, WHIP1], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const uu = 1 - pPrev;
  const px = uu * uu * srcX + 2 * uu * pPrev * ctrlX + pPrev * pPrev * dotX;
  const py = uu * uu * srcY + 2 * uu * pPrev * ctrlY + pPrev * pPrev * dotY;
  const vx = x - px;
  const vy = y - py;
  const speed = Math.hypot(vx, vy);
  const blurred = frame >= WHIP0 + 3 && frame <= WHIP0 + 4 && speed > 40;
  const angle = Math.atan2(vy, vx);
  const stretch = blurred ? Math.min(1 + speed / 260, 2) : 1;

  // Glow fades as the orb condenses into a UI dot.
  const glow = Math.max(0, 1 - p * 1.3);

  return (
    <AbsoluteFill style={{zIndex: FILM_Z.whip, pointerEvents: 'none'}}>
      <div
        style={{
          position: 'absolute',
          left: x - r,
          top: y - r,
          width: r * 2,
          height: r * 2,
          borderRadius: '50%',
          background:
            p < 0.9
              ? 'radial-gradient(circle at 35% 30%, #C4AEFF 0%, #8B5CF6 45%, #6C3BFF 100%)'
              : C.violet,
          boxShadow:
            glow > 0.01
              ? `0 0 ${70 * glow}px ${26 * glow}px rgba(167,139,250,${0.55 * glow}), 0 0 ${180 * glow}px ${90 * glow}px rgba(167,139,250,${0.28 * glow})`
              : undefined,
          transform: blurred
            ? `rotate(${angle}rad) scaleX(${stretch}) rotate(${-angle}rad)`
            : undefined,
          filter: blurred ? 'blur(3px)' : undefined,
        }}
      />
    </AbsoluteFill>
  );
};
