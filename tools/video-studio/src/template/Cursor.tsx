import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {C} from './theme';

export type Waypoint = {
  frame: number;
  x: number;
  y: number;
  click?: boolean;
  // Perpendicular bulge of the curved path leading INTO this waypoint (px).
  bulge?: number;
};

const EASE = Easing.bezier(0.5, 0.05, 0.2, 1);

/** The pointer's position on a curved waypoint path at any frame. Pure, so the
 *  motion trail can sample it at frame-1, frame-2, … without duplicating the
 *  path maths. The movement system itself is unchanged from the approved
 *  prototype — only the skin and the trail are new. */
export function positionAt(
  path: Waypoint[],
  frame: number,
): {x: number; y: number} {
  const first = path[0]!;
  const last = path[path.length - 1]!;
  if (frame >= last.frame) return {x: last.x, y: last.y};

  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    if (frame >= a.frame && frame < b.frame) {
      const t = EASE((frame - a.frame) / (b.frame - a.frame));
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bulge = b.bulge ?? 0;
      const cx = (a.x + b.x) / 2 + (-dy / len) * bulge;
      const cy = (a.y + b.y) / 2 + (dx / len) * bulge;
      const u = 1 - t;
      return {
        x: u * u * a.x + 2 * u * t * cx + t * t * b.x,
        y: u * u * a.y + 2 * u * t * cy + t * t * b.y,
      };
    }
  }
  return {x: first.x, y: first.y};
}

/**
 * The signature Vendo pointer: brand violet fill, a white outline so it reads
 * on any surface, and a lilac glow. Deliberately not a stock macOS arrow — in
 * a host-app scene the pointer is the one thing on screen that is "us".
 */
const ArrowSvg: React.FC<{opacity?: number}> = ({opacity = 1}) => (
  <svg
    width={34}
    height={38}
    viewBox="0 0 15 17"
    style={{display: 'block', opacity}}
  >
    <path
      d="M1.5 1 L1.5 13.4 L4.9 10.5 L7 15.5 L9.4 14.5 L7.2 9.7 L11.7 9.5 Z"
      fill={C.violet}
      stroke="#FFFFFF"
      strokeWidth={1.2}
      strokeLinejoin="round"
    />
  </svg>
);

/** 3-frame fading trail, drawn only while the pointer is genuinely moving fast
 *  — a slow drift leaves no smear, the same rule the chip storm uses. */
const TRAIL = [
  {back: 1, opacity: 0.34},
  {back: 2, opacity: 0.18},
  {back: 3, opacity: 0.08},
];
const TRAIL_SPEED = 14;

const Ripple: React.FC<{x: number; y: number; start: number}> = ({
  x,
  y,
  start,
}) => {
  const frame = useCurrentFrame();
  if (frame < start || frame > start + 18) return null;
  const p = interpolate(frame, [start, start + 18], [0, 1], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const size = 14 + p * 140;
  // Tiny white flash at the hotspot, on top of the violet ripple.
  const fp = interpolate(frame, [start, start + 4], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const flashSize = 10 + fp * 16;
  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: x - size / 2,
          top: y - size / 2,
          width: size,
          height: size,
          borderRadius: '50%',
          border: `${4 - 2.6 * p}px solid ${C.violet}`,
          opacity: 0.9 * (1 - p),
          zIndex: 98,
        }}
      />
      {fp < 1 && (
        <div
          style={{
            position: 'absolute',
            left: x - flashSize / 2,
            top: y - flashSize / 2,
            width: flashSize,
            height: flashSize,
            borderRadius: '50%',
            backgroundColor: '#FFFFFF',
            boxShadow: '0 0 14px 4px rgba(255,255,255,0.8)',
            opacity: 1 - fp,
            zIndex: 98,
          }}
        />
      )}
    </>
  );
};

export const Cursor: React.FC<{path: Waypoint[]}> = ({path}) => {
  const frame = useCurrentFrame();

  const {x, y} = positionAt(path, frame);
  const previous = positionAt(path, frame - 1);
  const speed = Math.hypot(x - previous.x, y - previous.y);

  // Press: scale down to 0.85 around each click.
  let press = 1;
  for (const wp of path) {
    if (wp.click && frame >= wp.frame - 3 && frame <= wp.frame + 6) {
      press = Math.min(
        press,
        interpolate(
          frame,
          [wp.frame - 3, wp.frame, wp.frame + 2, wp.frame + 6],
          [1, 0.85, 0.85, 1],
        ),
      );
    }
  }

  return (
    <>
      {path
        .filter((w) => w.click)
        .map((w) => (
          <Ripple key={`${w.frame}:${w.x}:${w.y}`} x={w.x} y={w.y} start={w.frame} />
        ))}

      {speed > TRAIL_SPEED
        ? TRAIL.map(({back, opacity}) => {
            const ghost = positionAt(path, frame - back);
            return (
              <div
                key={back}
                style={{
                  position: 'absolute',
                  left: ghost.x,
                  top: ghost.y,
                  transform: `scale(${press})`,
                  transformOrigin: '4px 4px',
                  zIndex: 98,
                }}
              >
                <ArrowSvg opacity={opacity} />
              </div>
            );
          })
        : null}

      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          transform: `scale(${press})`,
          transformOrigin: '4px 4px',
          zIndex: 99,
          filter:
            'drop-shadow(0 0 10px rgba(167,139,250,0.75)) drop-shadow(0 2px 5px rgba(14,11,26,0.28))',
        }}
      >
        <ArrowSvg />
      </div>
    </>
  );
};
