import React from 'react';
import {
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C} from './theme';

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

