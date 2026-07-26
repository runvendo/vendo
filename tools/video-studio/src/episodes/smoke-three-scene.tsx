import React from 'react';
import type {EpisodeSpec} from '../template/episode-spec';
import {Detonation} from '../template/Detonation';
import {SceneClick} from '../scenes/SceneClick';
import {SceneEruption} from '../scenes/SceneEruption';
import {SceneClaim} from '../scenes/SceneClaim';

/**
 * Episode two, written purely to prove the template is reusable: a different
 * blank, different copy, a different corpus and a different scene set, with
 * ZERO edits to anything under ../template.
 *
 * Written from README.md's instructions in one sitting. Kept as evidence of
 * the template contract rather than as a shipping episode.
 */

const BLANK = 'automations';

const FEATURE = {
  title: 'Automations',
  subtitle: 'Let the agent run scheduled tasks for you',
};

const Click: React.FC = () => (
  <SceneClick
    sectionLabel="Workspace settings"
    feature={FEATURE}
    nextFeature={{
      title: 'Knowledge',
      subtitle: 'Give your agent your docs, schema, and data',
    }}
  />
);

const Eruption: React.FC = () => (
  <SceneEruption
    lines={['State-of-the-art', `${BLANK}.`]}
    feature={FEATURE}
    files={[
      'weekly-digest.ts',
      'renewal-sweep.ts',
      'dunning.ts',
      'invoice-chase.ts',
      'churn-alert.ts',
      'usage-report.ts',
      'seat-audit.ts',
      'trial-nudge.ts',
      'billing-recap.ts',
      'nps-pulse.ts',
      'stale-lead.ts',
      'quota-watch.ts',
    ]}
  />
);

const Claim: React.FC = () => (
  <SceneClaim claim={`State-of-the-art ${BLANK}.`} payoff="One click." />
);

export const smokeThreeScene: EpisodeSpec = {
  id: 'SmokeThreeScene',
  blank: BLANK,
  durationInFrames: 155,
  fps: 30,
  // Deliberately 480p: this episode exists to prove the template is reusable,
  // and a cheap proof render should be cheap. 854x480 is the standard 480p 16:9
  // frame; the template fits the 1920x1080 stage into it (stageFit).
  width: 854,
  height: 480,
  scenes: [
    {id: 'click', component: Click, from: 0, durationInFrames: 18},
    {id: 'eruption', component: Eruption, from: 18, durationInFrames: 57},
    {id: 'claim', component: Claim, from: 75, durationInFrames: 80},
  ],
  // Only the detonation: an episode picks the overlays its cuts need.
  overlays: [Detonation],
};
