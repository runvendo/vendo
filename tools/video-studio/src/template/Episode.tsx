import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {C} from './theme';
import {ONEST_FAMILY} from './onest';
import {STAGE, stageFit} from './episode-spec';
import type {EpisodeSpec} from './episode-spec';

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
  const {width, height} = useVideoConfig();
  const shake = frame >= 9 && frame < 12 ? SHAKE[frame - 9]! : [0, 0];
  // Scenes are authored on the 1920x1080 STAGE. An episode that declares a
  // smaller composition (a cheap proof render at 854x480, say) gets the same
  // film fitted into it — the resolution is the episode's own explicit
  // width/height, never a CLI scale flag, so `pnpm render` reproduces it.
  const fit = stageFit(width, height);

  const film = (
    <AbsoluteFill
        // `transform: none` off the shake frames on purpose: ANY transform makes
        // this a stacking context, which would trap the film's layers below the
        // real overlay panel (it portals to document.body carrying the product's
        // z-index: 2147483001). Off-shake frames therefore carry no transform at
        // all, so FILM_Z can reach over the panel. An identity translate and no
        // translate are visually identical, so the shake itself is unchanged.
        style={
          shake[0] === 0 && shake[1] === 0
            ? undefined
            : {transform: `translate(${shake[0]}px, ${shake[1]}px)`}
        }
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
  );

  return (
    <AbsoluteFill style={{backgroundColor: C.bg, fontFamily: ONEST_FAMILY}}>
      {/* At 1:1 the film mounts with NO wrapper: a `scale(1)` transform would
          still create a stacking context and trap FILM_Z below the real
          overlay panel. */}
      {fit === 1 ? (
        film
      ) : (
        <div
          style={{
            width: STAGE.width,
            height: STAGE.height,
            transform: `scale(${fit})`,
            transformOrigin: 'top left',
          }}
        >
          {film}
        </div>
      )}
      {episode.audioSrc === undefined ? null : <Audio src={episode.audioSrc} />}
    </AbsoluteFill>
  );
};
