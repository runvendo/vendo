import React from 'react';
import type {UIMessage} from 'ai';
import type {TreeNode, UIPayload, VendoKnowledgeCitation} from '@vendoai/core';
import {MessageList} from '../../../../packages/ui/src/chrome/thread/message-list';
import {ThreadMessage} from '../../../../packages/ui/src/chrome/thread/message';

/**
 * The film's bridge to the real agent surface.
 *
 * Nothing here draws a chat: it builds the exact `UIMessage` / `UIPayload`
 * values the product's own stream carries, as a function of the current frame,
 * and hands them to the real components. The transcript on camera is rendered
 * by packages/ui's ThreadMessage → ThreadPart → {Markdown, TurnCitations,
 * ThreadAppCard → PayloadView}, which is the same path a live turn takes.
 */

/** Progressive slice of a string — the composer typing, driven by the frame. */
export const typedText = (text: string, elapsed: number, rate = 1): string =>
  text.slice(0, Math.max(0, Math.floor(elapsed / rate)));

export const userTurn = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{type: 'text', text}],
});

/** An assistant answer, optionally carrying its knowledge citations. The
 *  citations part is what lights up the real `Sources` chip row — the chips
 *  are never authored directly. */
export const answerTurn = (
  id: string,
  text: string,
  citations?: VendoKnowledgeCitation[],
): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {type: 'text', text},
    ...(citations === undefined
      ? []
      : [
          {
            type: 'data-vendo-citations',
            data: {outcome: 'answered', citations},
          } as unknown as UIMessage['parts'][number],
        ]),
  ],
});

/** An assistant turn carrying a generated view — the real in-thread app card. */
export const viewTurn = (
  id: string,
  appId: string,
  payload: UIPayload,
): UIMessage => ({
  id,
  role: 'assistant',
  parts: [
    {
      type: 'data-vendo-view',
      data: {appId, payload},
    } as unknown as UIMessage['parts'][number],
  ],
});

/**
 * The weekly-usage view, assembled the way the product assembles one: as a
 * sequence of payload revisions. `revealed` names which sections have arrived,
 * so the real renderer paints each one as it lands instead of the film drawing
 * a fake build-up.
 *
 * Every node is Kit vocabulary with no `source: "generated"`, which keeps the
 * tree out of the sandboxed jail iframe (packages/ui/src/tree/renderer.tsx only
 * jails generated nodes) and therefore capturable by Remotion.
 */
export interface ViewReveal {
  stats: boolean;
  chart: boolean;
  schedule: boolean;
}

const USAGE_SERIES = [
  {week: 'Jun 2', calls: 780_000},
  {week: 'Jun 9', calls: 845_000},
  {week: 'Jun 16', calls: 910_000},
  {week: 'Jun 23', calls: 1_020_000},
  {week: 'Jun 30', calls: 1_090_000},
  {week: 'Jul 7', calls: 1_240_000},
];

export function weeklyUsagePayload(
  revealed: ViewReveal,
  streaming: boolean,
): UIPayload {
  const children: string[] = [];
  const nodes: TreeNode[] = [];

  // No heading node: the real app card's own bar titles the view from
  // `payload.name`, so a Text heading here would double the title on camera.
  if (revealed.stats) {
    children.push('stats');
    nodes.push({
      id: 'stats',
      component: 'Row',
      props: {gap: 16},
      children: ['seats', 'calls', 'reports'],
    });
    nodes.push(
      {
        id: 'seats',
        component: 'Stat',
        props: {label: 'Active seats', value: 42},
      },
      {
        id: 'calls',
        component: 'Stat',
        props: {label: 'API calls', value: '1.2M', tone: 'accent'},
      },
      {
        id: 'reports',
        component: 'Stat',
        props: {label: 'Reports sent', value: 4},
      },
    );
  }

  if (revealed.chart) {
    children.push('chart');
    nodes.push({
      id: 'chart',
      component: 'LineChart',
      props: {
        data: USAGE_SERIES,
        xKey: 'week',
        series: [{key: 'calls', label: 'API calls'}],
        height: 150,
      },
    });
  }

  if (revealed.schedule) {
    children.push('schedule');
    nodes.push({
      id: 'schedule',
      component: 'Badge',
      props: {label: 'every Monday · 9:00', tone: 'neutral'},
    });
  }

  return {
    formatVersion: 'vendo-genui/v2',
    root: 'root',
    name: 'Weekly usage',
    nodes: [
      {id: 'root', component: 'Stack', props: {gap: 18}, children},
      ...nodes,
    ],
    ...(streaming ? {streaming: true} : {}),
  } as UIPayload;
}

const noop = (): undefined => undefined;

/**
 * One real turn, on its own. Used where the film shows a generated view OUTSIDE
 * a conversation — the shared-element ghost mid-flight, and the card once it is
 * pinned to the host dashboard — so the transcript pane's own container chrome
 * would be wrong there. Still the product's component all the way down:
 * `ThreadMessage` → `ThreadPart` → `ThreadAppCard` → `PayloadView`.
 */
export const Turn: React.FC<{message: UIMessage}> = ({message}) => (
  <ThreadMessage
    message={message}
    restored
    risks={new Map()}
    busy={false}
    onEditLast={noop}
    onRegenerateLast={noop}
  />
);

/**
 * A stretch of transcript on camera, rendered by the product's own transcript
 * pane — `MessageList` ("the windowed message list … pure presentation over the
 * thread-level state"), which fans out to `ThreadMessage` → `ThreadPart` →
 * {Markdown, TurnCitations, ThreadAppCard → PayloadView}.
 *
 * Mounting the real list rather than hand-rolling `.fl-thread`/`.fl-msglist`
 * means the studio authors ZERO product class names: every container, message,
 * chip and card class on camera is emitted inside packages/ui.
 *
 * The props below are the live thread's state, at the value a settled turn
 * carries: nothing is parked for approval, nothing is streaming its first
 * chunk, the reader is at the bottom, and there is no older history to page in.
 * `restored` (via `isRestored`) suppresses the components' own CSS entrance so
 * the film's frame-driven motion is the only motion.
 */
export const Transcript: React.FC<{messages: UIMessage[]}> = ({messages}) => (
  <MessageList
    scroll={{
      listRef: {current: null},
      onScroll: noop,
      jumpToLatest: noop,
      showJump: false,
      unseenCount: 0,
      snippet: '',
    }}
    messageWindow={{
      windowed: messages,
      hasOlder: false,
      olderCount: 0,
      loadOlder: noop,
      onNearTop: noop,
    }}
    busy={false}
    risks={new Map()}
    isRestored={() => true}
    onEditLast={noop}
    onRegenerateLast={noop}
    approvals={[]}
    guardApprovals={new Map()}
    cardRefs={{current: new Map()}}
    respond={noop}
    onMorph={noop}
    sendMessage={noop}
    awaitingFirstChunk={false}
    working={false}
  />
);
