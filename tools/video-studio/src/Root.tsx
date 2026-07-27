import React from 'react';
import {Composition} from 'remotion';
import {Episode} from './template/Episode';
import {episodes} from './episodes';

// An EpisodeSpec holds React components, which cannot travel through
// Remotion's `defaultProps` (those are serialized, so functions are dropped
// and every scene arrives as undefined). Each episode is bound to its own
// component here instead, at module scope so the identity is stable across
// renders.
const films = episodes.map((episode) => {
  const Film: React.FC = () => <Episode episode={episode} />;
  Film.displayName = `Film(${episode.id})`;
  return {episode, Film};
});

/** One composition per episode. The template renders them all. */
export const Root: React.FC = () => (
  <>
    {films.map(({episode, Film}) => (
      <Composition
        key={episode.id}
        id={episode.id}
        component={Film}
        durationInFrames={episode.durationInFrames}
        fps={episode.fps}
        width={episode.width}
        height={episode.height}
      />
    ))}
  </>
);
