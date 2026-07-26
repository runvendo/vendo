import type {EpisodeSpec} from '../template/episode-spec';
import {oneClickKnowledge} from './one-click-knowledge';

/** Every episode the studio can render. Adding one is: write the file, add it
 *  here. Nothing in ../template changes. */
export const episodes: EpisodeSpec[] = [oneClickKnowledge];
