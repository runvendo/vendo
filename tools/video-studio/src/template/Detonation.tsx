import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {FILM_Z, pushIn} from './theme';
import {VendoMark} from './ui';

// THE PURPLE DETONATION. Global-frame overlay rendered above all scenes.
// Click at frame 8 → three layered radial bursts at different speeds +
// a thin white shockwave ring past the viewport → full violet hold with
// the white vendo mark spring-snapped to SCREEN CENTER → contraction into
// the agent orb of the eruption scene (hard handoff, no crossfade).

const CLICK = {x: 1560, y: 512};
const ORB = {x: 1290, y: 430};

const T_CLICK = 8; // detonation starts
const T_FULL = 15; // screen fully flooded
const T_HOLD_END = 28; // contraction begins (full violet through ~0.9s)
const T_DONE = 38; // circle has become the orb
const R_COVER = 1720; // radius covering the whole 1920x1080 frame from CLICK

const Circle: React.FC<{
  cx: number;
  cy: number;
  r: number;
  background: string;
  boxShadow?: string;
}> = ({cx, cy, r, background, boxShadow}) => (
  <div
    style={{
      position: 'absolute',
      left: cx - r,
      top: cy - r,
      width: r * 2,
      height: r * 2,
      borderRadius: '50%',
      background,
      boxShadow,
    }}
  />
);

export const Detonation: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  if (frame < T_CLICK || frame > T_DONE) return null;

  const burst = (start: number, end: number) =>
    interpolate(frame, [start, end], [0, R_COVER], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  // Three layered bursts at distinctly different speeds: lilac tears ahead,
  // mid-violet chases, brand violet lands the flood.
  const rLilac = burst(T_CLICK, T_FULL - 3);
  const rMid = burst(T_CLICK, T_FULL - 1);
  const rViolet = burst(T_CLICK + 1, T_FULL);

  // Thin white shockwave ring expanding past the viewport.
  const shockP = interpolate(frame, [T_CLICK, T_CLICK + 12], [0, 1], {
    easing: Easing.out(Easing.quad),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const shockR = shockP * 2400;
  const shockW = 12 - 9 * shockP;
  const shockO = interpolate(shockP, [0, 0.15, 1], [0, 0.95, 0]);

  // Contraction: full-screen violet collapses into the agent orb underneath.
  // The eruption scene runs its own push-in, so the orb's on-screen position
  // is its layout position scaled around screen center.
  const eruptionLocal = frame - 18;
  const sc = pushIn(eruptionLocal, 57);
  const orbX = 960 + (ORB.x - 960) * sc;
  const orbY = 540 + (ORB.y - 540) * sc;
  const contract = interpolate(frame, [T_HOLD_END, T_DONE], [0, 1], {
    easing: Easing.inOut(Easing.cubic),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const cx = interpolate(contract, [0, 1], [CLICK.x, orbX]);
  const cy = interpolate(contract, [0, 1], [CLICK.y, orbY]);
  const rMain = interpolate(contract, [0, 1], [rViolet, 76]);

  // As it contracts, the flood takes on the orb's own gradient and glow —
  // scene 2 is literally born out of the explosion. Hard cut at T_DONE:
  // the real orb underneath takes over on the next frame (no crossfade,
  // no double exposure).
  const mainBg =
    contract > 0
      ? 'radial-gradient(circle at 35% 30%, #C4AEFF 0%, #8B5CF6 45%, #6C3BFF 100%)'
      : '#6C3BFF';
  const glowShadow =
    contract > 0
      ? `0 0 70px 26px rgba(167,139,250,${0.55 * contract}), 0 0 180px 90px rgba(167,139,250,${0.28 * contract})`
      : undefined;

  // White vendo mark spring-snaps to SCREEN CENTER for the hold,
  // with overshoot (~1.15 -> 1.0).
  const markIn =
    frame < T_FULL - 4
      ? 0
      : spring({
          frame: frame - (T_FULL - 4),
          fps,
          config: {damping: 9, stiffness: 150, mass: 0.7},
        });
  const markOut = interpolate(frame, [T_HOLD_END, T_HOLD_END + 5], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{zIndex: FILM_Z.detonation, pointerEvents: 'none'}}>
      {contract === 0 && (
        <>
          <Circle cx={CLICK.x} cy={CLICK.y} r={rLilac} background="#A78BFA" />
          <Circle cx={CLICK.x} cy={CLICK.y} r={rMid} background="#8B5CF6" />
        </>
      )}
      <Circle
        cx={cx}
        cy={cy}
        r={rMain}
        background={mainBg}
        boxShadow={glowShadow}
      />
      {shockO > 0.01 && shockR > 1 && (
        <div
          style={{
            position: 'absolute',
            left: CLICK.x - shockR,
            top: CLICK.y - shockR,
            width: shockR * 2,
            height: shockR * 2,
            borderRadius: '50%',
            border: `${shockW}px solid rgba(255,255,255,${shockO})`,
          }}
        />
      )}
      {markOut > 0 && markIn > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 960,
            top: 540,
            transform: `translate(-50%, -50%) scale(${markIn * markOut})`,
            opacity: markOut,
          }}
        >
          <VendoMark size={310} white />
        </div>
      )}
    </AbsoluteFill>
  );
};
