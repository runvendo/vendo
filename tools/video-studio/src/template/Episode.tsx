import React from 'react';
import {AbsoluteFill, Audio, Sequence, useCurrentFrame} from 'remotion';
import {loadFont} from '@remotion/google-fonts/Onest';
import {C} from './theme';
import type {EpisodeSpec} from './episode-spec';

const {fontFamily} = loadFont('normal', {
  weights: ['400', '500', '600', '700', '800'],
  subsets: ['latin'],
});

/** 3-frame, 4px screen shake on the detonation impact. Part of the template's
 *  beat skeleton, not the episode's: every episode detonates on the same frame. */
const SHAKE: Array<[number, number]> = [
  [4, -3],
  [-4, 2],
  [3, 3],
];

/** The shared film. An episode supplies scenes, copy and the blank; everything
 *  here — the shake, the sequence tiling, the overlay stack, the audio slot —
 *  is the template and is identical across episodes. */
export const Episode: React.FC<{episode: EpisodeSpec}> = ({episode}) => {
  const frame = useCurrentFrame();
  const shake = frame >= 9 && frame < 12 ? SHAKE[frame - 9]! : [0, 0];

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, fontFamily}}>
      <AbsoluteFill
        style={{transform: `translate(${shake[0]}px, ${shake[1]}px)`}}
      >
        {episode.scenes.map((scene) => (
          <Sequence
            key={scene.id}
            from={scene.from}
            durationInFrames={scene.durationInFrames}
          >
            <scene.component />
          </Sequence>
        ))}
        {episode.overlays.map((Overlay, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <Overlay key={index} />
        ))}
      </AbsoluteFill>
      {episode.audioSrc === undefined ? null : <Audio src={episode.audioSrc} />}
    </AbsoluteFill>
  );
};
