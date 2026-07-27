import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, pushIn, snap} from '../template/theme';
import {VendoMark} from '../template/ui';

// Frames 390-420 (30 local). Wordmark out. Hard cut to end.

export const SceneOut: React.FC = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const {s, o} = snap(frame, fps, 0);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        justifyContent: 'center',
        alignItems: 'center',
        transform: `scale(${pushIn(frame, 30)})`,
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 44,
          opacity: o,
          transform: `scale(${0.82 + 0.18 * s})`,
        }}
      >
        <VendoMark size={190} />
        <div
          style={{
            fontSize: 150,
            fontWeight: 800,
            color: C.ink,
            letterSpacing: '-0.03em',
            display: 'flex',
            alignItems: 'baseline',
          }}
        >
          vendo
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              backgroundColor: C.violet,
              display: 'inline-block',
              marginLeft: 10,
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
