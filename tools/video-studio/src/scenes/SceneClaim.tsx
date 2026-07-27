import React from 'react';
import {AbsoluteFill, useCurrentFrame, useVideoConfig} from 'remotion';
import {C, pushIn, snap, snapStyle} from '../template/theme';

// Frames 310-390 (80 local). Clean white claim card.

export interface SceneClaimProps {
  /** The blanked headline, e.g. "State-of-the-art knowledge base." */
  claim: string;
  /** The payoff line. The final character is set in brand violet. */
  payoff: string;
}

export const SceneClaim: React.FC<SceneClaimProps> = ({claim, payoff}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const l1 = snap(frame, fps, 2);
  const l2 = snap(frame, fps, 30);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.white,
        justifyContent: 'center',
        alignItems: 'center',
        transform: `scale(${pushIn(frame, 80)})`,
      }}
    >
      <div
        style={{
          fontSize: 96,
          fontWeight: 800,
          color: C.ink,
          letterSpacing: '-0.03em',
          textAlign: 'center',
          ...snapStyle(l1.s, l1.o, 42),
        }}
      >
        {claim}
      </div>
      <div
        style={{
          marginTop: 34,
          fontSize: 96,
          fontWeight: 800,
          color: C.ink,
          letterSpacing: '-0.03em',
          textAlign: 'center',
          ...snapStyle(l2.s, l2.o, 42),
        }}
      >
        {payoff.slice(0, -1)}
        <span style={{color: C.violet}}>{payoff.slice(-1)}</span>
      </div>
    </AbsoluteFill>
  );
};
