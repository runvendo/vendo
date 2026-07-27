import React from 'react';
import type {VendoKnowledgeCitation} from '@vendoai/core';
import type {EpisodeSpec} from '../template/episode-spec';
import {Detonation} from '../template/Detonation';
import {OrbWhip} from '../template/OrbWhip';
import {WidgetFlight} from '../template/WidgetFlight';
import {SceneClick} from '../scenes/SceneClick';
import {SceneEruption} from '../scenes/SceneEruption';
import {SceneChat} from '../scenes/SceneChat';
import {SceneProofC} from '../scenes/SceneProofC';
import {SceneClaim} from '../scenes/SceneClaim';
import {SceneOut} from '../scenes/SceneOut';

/**
 * Episode one: "State of the art KNOWLEDGE in one click."
 *
 * Everything episode-specific lives in this file — the blank, the copy, the
 * scene beats. The film grammar (detonation, camera law, cursor, the seven
 * transition rules) belongs to ../template and is shared by every episode.
 * See ../../README.md to add episode two.
 */

const BLANK = 'knowledge';

const FEATURE = {
  title: 'Knowledge',
  subtitle: 'Give your agent your docs, schema, and data',
};

const NEXT_FEATURE = {
  title: 'Automations',
  subtitle: 'Let the agent run scheduled tasks for you',
};

const CITATIONS: VendoKnowledgeCitation[] = [
  {
    docId: 'docs/auth.mdx',
    chunkId: '4',
    title: 'docs/auth.mdx §4',
    source: 'Product docs',
    kind: 'api',
    visibility: 'public',
    snippet:
      'Vendo supports SAML 2.0 and OIDC. Group claims map to workspace roles through the role-mapping table.',
  },
  {
    docId: 'docs/sso-setup.mdx',
    chunkId: '2',
    title: 'sso-setup.mdx §2',
    source: 'Product docs',
    kind: 'api',
    visibility: 'public',
    snippet:
      'Map an identity-provider group to a Vendo role once; every future member of that group inherits it.',
  },
];

const Click: React.FC = () => (
  <SceneClick
    sectionLabel="Workspace settings"
    feature={FEATURE}
    nextFeature={NEXT_FEATURE}
  />
);

const Eruption: React.FC = () => (
  <SceneEruption lines={['State-of-the-art', `${BLANK}.`]} feature={FEATURE} />
);

const Chat: React.FC = () => (
  <SceneChat
    askA="do we support SSO with role mapping?"
    answer="Yes. SAML and OIDC, with group-to-role mapping."
    citations={CITATIONS}
    askB="set up a weekly usage report for my team"
  />
);

const Claim: React.FC = () => (
  <SceneClaim
    claim={`State-of-the-art ${BLANK} base.`}
    payoff="One click."
  />
);

export const oneClickKnowledge: EpisodeSpec = {
  id: 'OneClickKnowledge',
  blank: BLANK,
  durationInFrames: 420,
  fps: 30,
  width: 1920,
  height: 1080,
  scenes: [
    // The cut at 18 happens under the full-violet detonation flood.
    {id: 'click', component: Click, from: 0, durationInFrames: 18},
    {id: 'eruption', component: Eruption, from: 18, durationInFrames: 57},
    // The dashboard mounts early, BELOW the chat: the chat fades back to
    // reveal it mid-pullback while the view flies across.
    {id: 'dashboard', component: SceneProofC, from: 244, durationInFrames: 66},
    // One continuous chat panel: proof A -> scroll -> proof B.
    {id: 'chat', component: Chat, from: 75, durationInFrames: 177},
    {id: 'claim', component: Claim, from: 310, durationInFrames: 80},
    {id: 'endcard', component: SceneOut, from: 390, durationInFrames: 30},
  ],
  overlays: [Detonation, OrbWhip, WidgetFlight],
};
