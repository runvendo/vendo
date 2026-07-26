import React from 'react';
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C, SPRING_CFG} from './theme';

// The real vendo blob mark (imported asset — never redrawn).
// `white` recolors the violet fills to pure white via CSS filter.
export const VendoMark: React.FC<{
  size: number;
  white?: boolean;
  style?: React.CSSProperties;
}> = ({size, white = false, style}) => (
  <Img
    src={staticFile('brand/vendo-mark-violet.svg')}
    style={{
      width: size,
      height: size * (6586.116 / 6749.64),
      display: 'block',
      filter: white ? 'brightness(0) invert(1)' : undefined,
      ...style,
    }}
  />
);

// Animated toggle. `flipAt` = frame (scene-local) at which it turns on.
// Sized via `scale` (base: 88x50 track).
export const Toggle: React.FC<{flipAt: number; scale?: number}> = ({
  flipAt,
  scale = 1,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const s =
    frame < flipAt
      ? 0
      : spring({frame: frame - flipAt, fps, config: SPRING_CFG});
  const w = 88 * scale;
  const h = 50 * scale;
  const pad = 5 * scale;
  const knob = h - pad * 2;
  const knobX = pad + s * (w - knob - pad * 2);
  const trackOn = interpolate(s, [0, 0.5], [0, 1], {
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        width: w,
        height: h,
        borderRadius: h / 2,
        backgroundColor: trackOn > 0.5 ? C.violet : '#E4E2EC',
        position: 'relative',
        transition: 'none',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: pad,
          left: knobX,
          width: knob,
          height: knob,
          borderRadius: '50%',
          backgroundColor: C.white,
          boxShadow: '0 2px 6px rgba(14,11,26,0.18)',
        }}
      />
    </div>
  );
};

export const DocIcon: React.FC<{size?: number; color?: string}> = ({
  size = 18,
  color = C.muted,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{display: 'block', flexShrink: 0}}
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);

// Gray placeholder bar for fake UI content.
export const Bar: React.FC<{
  w: number;
  h?: number;
  color?: string;
  style?: React.CSSProperties;
}> = ({w, h = 12, color = C.barFill, style}) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: h / 2,
      backgroundColor: color,
      ...style,
    }}
  />
);
