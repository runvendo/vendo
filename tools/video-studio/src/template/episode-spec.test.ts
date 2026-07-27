import {describe, expect, it} from 'vitest';
import {
  coverageGaps,
  episodeSeconds,
  overflowingScenes,
  type EpisodeSpec,
} from './episode-spec.js';
import {episodes} from '../episodes/index.js';

const stub = () => null;

const spec = (
  scenes: Array<{id: string; from: number; durationInFrames: number}>,
  durationInFrames: number,
): EpisodeSpec => ({
  id: 'Test',
  blank: 'knowledge',
  durationInFrames,
  fps: 30,
  width: 1920,
  height: 1080,
  scenes: scenes.map((scene) => ({...scene, component: stub})),
  overlays: [],
});

describe('coverageGaps', () => {
  it('reports nothing when scenes tile the whole episode', () => {
    expect(
      coverageGaps(
        spec(
          [
            {id: 'a', from: 0, durationInFrames: 50},
            {id: 'b', from: 50, durationInFrames: 50},
          ],
          100,
        ),
      ),
    ).toEqual([]);
  });

  it('allows scenes to overlap — the template cross-fades proofs', () => {
    expect(
      coverageGaps(
        spec(
          [
            {id: 'a', from: 0, durationInFrames: 70},
            {id: 'b', from: 40, durationInFrames: 60},
          ],
          100,
        ),
      ),
    ).toEqual([]);
  });

  it('reports a hole between scenes — those frames would render black', () => {
    expect(
      coverageGaps(
        spec(
          [
            {id: 'a', from: 0, durationInFrames: 40},
            {id: 'b', from: 60, durationInFrames: 40},
          ],
          100,
        ),
      ),
    ).toEqual([[40, 60]]);
  });

  it('reports a hole at the tail', () => {
    expect(
      coverageGaps(spec([{id: 'a', from: 0, durationInFrames: 80}], 100)),
    ).toEqual([[80, 100]]);
  });
});

describe('overflowingScenes', () => {
  it('names scenes that run past the end of the episode', () => {
    expect(
      overflowingScenes(
        spec(
          [
            {id: 'a', from: 0, durationInFrames: 100},
            {id: 'tail', from: 90, durationInFrames: 30},
          ],
          100,
        ),
      ),
    ).toEqual(['tail']);
  });
});

describe('the registered episodes', () => {
  it('registers at least the knowledge episode', () => {
    expect(episodes.map((episode) => episode.id)).toContain(
      'OneClickKnowledge',
    );
  });

  it('gives every episode a unique composition id', () => {
    const ids = episodes.map((episode) => episode.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every episode a blank to fill the "one click" line', () => {
    for (const episode of episodes) {
      expect(episode.blank.length).toBeGreaterThan(0);
    }
  });

  it('leaves no uncovered frames and no overflow in any episode', () => {
    for (const episode of episodes) {
      expect({id: episode.id, gaps: coverageGaps(episode)}).toEqual({
        id: episode.id,
        gaps: [],
      });
      expect({id: episode.id, over: overflowingScenes(episode)}).toEqual({
        id: episode.id,
        over: [],
      });
    }
  });

  it('holds the knowledge episode to the contracted 14s ±0.5s at 1080p30', () => {
    const knowledge = episodes.find(
      (episode) => episode.id === 'OneClickKnowledge',
    );
    if (!knowledge) throw new Error('knowledge episode is not registered');
    expect(knowledge.fps).toBe(30);
    expect(knowledge.width).toBe(1920);
    expect(knowledge.height).toBe(1080);
    expect(episodeSeconds(knowledge)).toBeGreaterThanOrEqual(13.5);
    expect(episodeSeconds(knowledge)).toBeLessThanOrEqual(14.5);
  });
});
