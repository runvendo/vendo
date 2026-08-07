/**
 * LANE D (spec §2 G1, §3 H1) — the run-activity store: what a surface OUTSIDE
 * the conversation may know about a turn that is running inside it.
 *
 * Closing the panel is leaving, never stopping: the overlay hides its portal
 * and the conversation keeps streaming underneath (ENG-221). The launcher pill
 * lives outside that portal, so the two cannot share React state — this is a
 * module singleton (the same shape as the toast queue) that every thread
 * surface publishes its turn into and the pill/badge read.
 *
 * Facts only. Whether a finished run counts as "unseen" is answered here by
 * one rule — a settle is unseen until somebody says it was seen — and the
 * overlay marks results seen the moment the panel is open.
 */
import type { BeatPhase } from "@vendoai/core";
import { isToolUIPart, type UIMessage } from "ai";
import { appTitle } from "./thread/message-data.js";

/**
 * §3.4 — one BEAT: the transient `data-vendo-status` channel's payload, after
 * the receiver has decided it is words a person may read. `phase` and `appId`
 * are present exactly when the harness sent usable ones (the receiver never
 * invents either).
 */
export interface VendoBeat {
  label: string;
  phase?: BeatPhase;
  appId?: string;
}

/** The live step of a running turn, for the pill's label + ring. */
export interface RunActivity {
  running: boolean;
  /** WHICH conversation is running. A host may mount several thread surfaces at
      once (the `/concurrent` scenario mounts an embedded thread beside an
      overlay) and this store answers for whichever one is running — so any
      surface that narrates a run has to check the run is one it is showing. */
  threadId?: string;
  /** §3.4 — the RUNNING turn's beats, oldest first. Ephemeral by the same rule
      as everything else here: nothing is running, so there is nothing to
      narrate, so the list is empty. */
  beats: readonly VendoBeat[];
  /** RAW tool name of the live step — the reader humanizes it (`toolTitle`). */
  tool?: string;
  /** Tool steps of the live turn that have settled, and how many it started.
      `total > 1` is what makes the ring determinate: an honest count of the
      steps the turn has actually begun, never a guess at what it will do
      next. */
  done: number;
  total: number;
}

/** One finished turn, as a line the user can act on from outside the panel. */
export interface RunResult {
  /** Bumped per settle so a reader can tell a new result from a re-render. */
  id: number;
  /** Plain-words headline: what the turn produced. */
  headline: string;
  /** Which conversation the record sits in (the toast's deep-link target). */
  threadId?: string;
  /** Tool steps the turn took — the transcript's "Did N things" count. */
  steps: number;
}

/** What a thread surface publishes: its transport status and its transcript. */
export interface ThreadRunSnapshot {
  threadId?: string;
  status: "submitted" | "streaming" | "ready" | "error";
  messages: UIMessage[];
  /** Omitted by a surface that narrates no beats — the same shape `threadId`
      has, and the same meaning as an empty list. */
  beats?: readonly VendoBeat[];
}

interface Derived extends RunActivity {
  threadId?: string;
  /** The turn yielded on an ask — paused, not finished (no result, no toast). */
  waiting: boolean;
  status: ThreadRunSnapshot["status"];
}

const NO_BEATS: readonly VendoBeat[] = [];
const IDLE: RunActivity = { running: false, done: 0, total: 0, beats: NO_BEATS };

const surfaces = new Map<symbol, Derived>();
const listeners = new Set<() => void>();
let activity: RunActivity = IDLE;
let result: RunResult | undefined;
let resultSeq = 0;
/** The last settle ANNOUNCED (conversation + last message id), so two surfaces
    on one conversation cannot raise two toasts for one turn. */
let announced: string | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * M25 — the toast headline is the turn's own first line, and the agent writes
 * MARKDOWN: the pill announced "### July spending" and "**Done** — see the
 * `spending` view" verbatim, syntax and all. The thread renders that text
 * through the markdown renderer; a toast has no renderer, so the syntax comes
 * off here instead of being read out as characters.
 */
function plainWords(line: string): string {
  return line
    // Leading block syntax: heading hashes, a blockquote, a list bullet or number.
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+)/, "")
    // Links and images keep their words, never their target.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    // Inline emphasis / code / strikethrough marks.
    .replace(/(\*\*|__|~~|[*_`])/g, "")
    .trim();
}

function firstLine(text: string): string {
  const raw = text.trim().split("\n").find(candidate => candidate.trim().length > 0) ?? "";
  const line = plainWords(raw);
  return line.length > 90 ? `${line.slice(0, 89).trimEnd()}…` : line;
}

function derive(snapshot: ThreadRunSnapshot): Derived {
  const last = snapshot.messages.at(-1);
  const parts = last?.role === "assistant" ? last.parts.filter(isToolUIPart) : [];
  let done = 0;
  let tool: string | undefined;
  let waiting = false;
  for (const part of parts) {
    // M23 — the pill's two lies, both from this loop:
    //   · a PARKED ask and a DENIED one were narrated as the live step ("Send
    //     money…" with a spinning ring while the card waited for a click, or
    //     after the user had already said no);
    //   · a denial never counted as done, so `done` could never reach `total`
    //     and the determinate ring stalled one step short for the whole turn.
    // A denial is settled; a parked ask is waiting, and its card is the record.
    if (part.state === "output-available" || part.state === "output-error"
      || part.state === "output-denied") done += 1;
    else if (part.state === "approval-requested") waiting = true;
    // Dynamic tools (host tools arrive that way) carry the name in the part,
    // not in the type — the same read BuildBeat does.
    else tool = part.type === "dynamic-tool" ? part.toolName : part.type.replace(/^tool-/, "");
  }
  return {
    running: snapshot.status === "submitted" || snapshot.status === "streaming",
    ...(tool === undefined ? {} : { tool }),
    done,
    total: parts.length,
    beats: snapshot.beats ?? NO_BEATS,
    ...(snapshot.threadId === undefined ? {} : { threadId: snapshot.threadId }),
    waiting,
    status: snapshot.status,
  };
}

/** The turn's own words, else the view it built, else what it did. */
function summarize(snapshot: ThreadRunSnapshot, steps: number): RunResult {
  const last = snapshot.messages.at(-1);
  const parts = last?.role === "assistant" ? last.parts : [];
  let headline: string | undefined;
  for (const part of parts) {
    if (part.type === "text" && part.text.trim().length > 0) headline = firstLine(part.text);
  }
  if (headline === undefined) {
    const view = parts.find(part => part.type === "data-vendo-view");
    const payload = view === undefined ? undefined : (view as { data?: { payload?: unknown } }).data?.payload;
    const name = payload === undefined ? undefined : appTitle(payload);
    headline = name !== undefined
      ? `${name} is ready`
      : steps === 1 ? "Did 1 thing" : `Did ${steps} things`;
  }
  return {
    id: ++resultSeq,
    headline,
    ...(snapshot.threadId === undefined ? {} : { threadId: snapshot.threadId }),
    steps,
  };
}

function recompute(): void {
  const live = [...surfaces.values()].find(surface => surface.running);
  const next: RunActivity = live === undefined
    ? IDLE
    : {
      running: true,
      ...(live.tool === undefined ? {} : { tool: live.tool }),
      ...(live.threadId === undefined ? {} : { threadId: live.threadId }),
      done: live.done,
      total: live.total,
      beats: live.beats,
    };
  const changed = next.running !== activity.running
    || next.threadId !== activity.threadId
    || next.tool !== activity.tool
    || next.done !== activity.done
    || next.total !== activity.total
    // The publisher hands over a stable array until a beat actually arrives.
    || next.beats !== activity.beats;
  if (changed) activity = next;
}

/**
 * One thread surface reporting its turn. Called from `useVendoThread`, so the
 * pill narrates whichever surface is actually running — panel, page, or an
 * ejected thread. `key` identifies the surface (a `Symbol` per hook instance),
 * so an idle surface can never clobber a running one.
 */
export function publishThreadRun(key: symbol, snapshot: ThreadRunSnapshot): void {
  const next = derive(snapshot);
  const previous = surfaces.get(key);
  surfaces.set(key, next);
  // A clean settle (streamed → ready, not parked on an ask) is a RESULT: the
  // one thing a user who left deserves to be told about. An errored turn is
  // not — the transcript owns failures (spec §15), and a turn that yielded on
  // an approval is waiting, not finished (the badge already counts it).
  const settled = previous?.running === true && !next.running
    && next.status === "ready" && !next.waiting;
  // A host may mount TWO thread surfaces on one conversation (VendoOverlay and
  // an ActivityPanel): each hook publishes independently, so ONE turn settled twice and
  // the user was told about it twice. The turn's identity is its conversation
  // plus its last message, so a second surface reporting the same settle is the
  // same news — announced once (Round B's dual-surface finding).
  const identity = `${snapshot.threadId ?? ""}::${snapshot.messages.at(-1)?.id ?? ""}`;
  if (settled && identity !== announced) {
    announced = identity;
    result = summarize(snapshot, next.done);
  }
  recompute();
  // Always notify: both snapshots keep stable identities while the facts are
  // unchanged, so React bails out of the render on its own.
  notify();
}

/** The surface unmounted — its run can no longer be narrated. */
export function retireThreadRun(key: symbol): void {
  if (!surfaces.delete(key)) return;
  recompute();
  notify();
}

export function subscribeRunActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function runActivity(): RunActivity {
  return activity;
}

/** The last clean settle nobody has looked at yet, else undefined. */
export function unseenRunResult(): RunResult | undefined {
  return result;
}

/** The user looked (panel opened, or the toast's View tapped). */
export function markRunResultsSeen(): void {
  if (result === undefined) return;
  result = undefined;
  notify();
}

/** Test/host teardown: forget every surface and any unseen result. */
export function resetRunActivity(): void {
  surfaces.clear();
  activity = IDLE;
  result = undefined;
  announced = undefined;
  notify();
}

/** SSR + first-render snapshots (stable identities for useSyncExternalStore). */
export const IDLE_RUN_ACTIVITY = IDLE;
