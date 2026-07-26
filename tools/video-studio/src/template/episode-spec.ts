import type React from 'react';

/** One beat of the film: a scene component and the global frames it owns.
 *  Scenes MAY overlap — the template deliberately mounts the dashboard under
 *  the chat so the chat can fade back and reveal it mid-pullback. */
export interface SceneBeat {
  id: string;
  component: React.FC;
  /** Global frame this scene mounts at. */
  from: number;
  durationInFrames: number;
}

/** An episode is scenes + copy + the blank. Everything else — camera law,
 *  cursor, detonation, the transition language — belongs to the template. */
export interface EpisodeSpec {
  /** Remotion composition id; also the render target name. */
  id: string;
  /** The "___" in "State of the art ___ in one click". */
  blank: string;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  scenes: SceneBeat[];
  /** Global-frame overlays that cross scene cuts (detonation, whip, flight). */
  overlays: React.FC[];
  /** Soundtrack slot. Episodes render silent until a track is supplied. */
  audioSrc?: string;
}

/** Every scene is authored against this stage. An episode may render at a
 *  smaller resolution; the template fits the stage into it. */
export const STAGE = {width: 1920, height: 1080} as const;

/** How much the stage shrinks to fit an episode's declared composition size.
 *  Exactly 1 for a 1920x1080 episode, so the film mounts untransformed. */
export const stageFit = (width: number, height: number): number =>
  Math.min(width / STAGE.width, height / STAGE.height);

export const episodeSeconds = (episode: EpisodeSpec): number =>
  episode.durationInFrames / episode.fps;

/** Frame ranges no scene covers. Those frames render as bare background, which
 *  on camera reads as a dropout — so the episode tests assert this is empty. */
export function coverageGaps(episode: EpisodeSpec): Array<[number, number]> {
  const covered = [...episode.scenes]
    .map((scene): [number, number] => [
      scene.from,
      scene.from + scene.durationInFrames,
    ])
    .sort((a, b) => a[0] - b[0]);

  const gaps: Array<[number, number]> = [];
  let reached = 0;
  for (const [start, end] of covered) {
    if (start > reached) gaps.push([reached, start]);
    reached = Math.max(reached, end);
  }
  if (reached < episode.durationInFrames) {
    gaps.push([reached, episode.durationInFrames]);
  }
  return gaps;
}

/** Ids of scenes that run past the end of the episode — their tail never renders. */
export function overflowingScenes(episode: EpisodeSpec): string[] {
  return episode.scenes
    .filter(
      (scene) => scene.from + scene.durationInFrames > episode.durationInFrames,
    )
    .map((scene) => scene.id);
}
