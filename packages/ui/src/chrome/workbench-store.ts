/**
 * The workbench feed: what the harness says about ITSELF while a turn runs,
 * for a dev-only surface to read.
 *
 * The channel is the transient `data-vendo-debug` part, so the same rule the
 * beats live under applies here — a diagnostic in `message.parts` would be
 * persisted history, and a diagnostic is not history. `onData` hands the chunk
 * over and the SDK drops it; this module is where it lands.
 *
 * A module singleton for the same reason `run-activity` is one: the reader is a
 * pane docked OUTSIDE the conversation's React tree, so the two cannot share
 * state through a provider.
 *
 * Facts only. Parts are kept per turn and ordered by the producer's own `seq`
 * (never by arrival — a subagent's parts interleave with the turn's own), and
 * nothing here derives, repairs or invents a field the harness did not send.
 */
import { useSyncExternalStore } from "react";

/** One thing the harness did, as it reported it. The producer pins this shape
    on the wire; the receiver reads it as sent. */
export type WorkbenchEvent =
  | { kind: "step-start"; step: number; maxSteps: number; activeTools: readonly string[] }
  | { kind: "step-end"; step: number; stopReason: string; durationMs: number;
      usage?: { inputTokens?: number; outputTokens?: number } }
  | { kind: "tool"; step: number; toolCallId: string; name: string; argsPreview: string;
      status: "ok" | "denied" | "error"; guard?: "run" | "ask" | "block";
      approval?: "auto" | "approved" | "timed-out" | "denied"; durationMs: number }
  | { kind: "context"; estTokens: number; windowTokens: number; triggerTokens: number }
  | { kind: "compaction"; reason: "trigger" | "overflow-retry"; summary: string }
  | { kind: "shed"; dropped: number }
  | { kind: "loadout"; active: readonly string[]; searchedIn: readonly string[];
      alwaysActive: readonly string[]; withheldCount: number }
  | { kind: "subagent"; label: string; steps: number; maxSteps: number; report?: string }
  | { kind: "error"; code: string; message: string }
  | { kind: "step-limit"; steps: number };

/** One event, addressed: whose turn, where in it, and which agent spoke. */
export type WorkbenchPart = {
  turnId: string;
  seq: number;
  at: number;
  agent: "resident" | "screen" | "subagent";
  event: WorkbenchEvent;
};

/** One turn's parts, oldest `seq` first. */
export interface WorkbenchTurn {
  turnId: string;
  parts: readonly WorkbenchPart[];
}

/** Written out rather than imported for the same reason `data-vendo-status` is
    in `use-vendo-thread`: the constant lives in @vendoai/harnesses, and
    @vendoai/ui may depend on core alone (scripts/dependency-guard.mjs). */
const DEBUG_PART = "data-vendo-debug";

/** The three seats and the ten kinds, as runtime sets. `Record<…, true>` so the
    build breaks if either closed union gains or loses a member. */
const AGENTS: Record<WorkbenchPart["agent"], true> = { resident: true, screen: true, subagent: true };
const EVENT_KINDS: Record<WorkbenchEvent["kind"], true> = {
  "step-start": true,
  "step-end": true,
  tool: true,
  context: true,
  compaction: true,
  shed: true,
  loadout: true,
  subagent: true,
  error: true,
  "step-limit": true,
};

const NO_TURNS: readonly WorkbenchTurn[] = [];

/** Turns kept before the oldest is dropped: the store is a module singleton
    that outlives every turn, so a dev session must not grow without bound. */
const MAX_TURNS = 20;

/** Holds the snapshot entries themselves, so a turn nothing landed in keeps the
    object and array the last snapshot handed out. */
const byTurn = new Map<string, WorkbenchTurn>();
const listeners = new Set<() => void>();
let feed: readonly WorkbenchTurn[] = NO_TURNS;

/**
 * A chunk, after the receiver has decided it is a part it can file. The
 * ADDRESS is the whole requirement — a chunk the pane cannot place in a turn,
 * in order, under a seat, is not a diagnostic it can show. The event's own
 * fields are read as sent (the kind is checked, its payload is not repaired):
 * the producer owns the shape, and a receiver that patched it would be the
 * author of a fact the harness never reported.
 */
function workbenchPart(chunk: { type: string; data?: unknown }): WorkbenchPart | undefined {
  if (chunk.type !== DEBUG_PART) return undefined;
  if (typeof chunk.data !== "object" || chunk.data === null) return undefined;
  const candidate = chunk.data as Partial<WorkbenchPart>;
  if (typeof candidate.turnId !== "string" || candidate.turnId.length === 0) return undefined;
  if (typeof candidate.seq !== "number" || typeof candidate.at !== "number") return undefined;
  if (typeof candidate.agent !== "string" || !Object.hasOwn(AGENTS, candidate.agent)) return undefined;
  const event = candidate.event as { kind?: unknown } | undefined;
  if (typeof event !== "object" || event === null) return undefined;
  if (typeof event.kind !== "string" || !Object.hasOwn(EVENT_KINDS, event.kind)) return undefined;
  return {
    turnId: candidate.turnId,
    seq: candidate.seq,
    at: candidate.at,
    agent: candidate.agent,
    event: event as WorkbenchEvent,
  };
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** One `onData` chunk, offered. Anything that is not a debug part is ignored,
 *  so the caller needs no branch of its own. */
export function publishWorkbenchPart(chunk: { type: string; data?: unknown }): void {
  const part = workbenchPart(chunk);
  if (part === undefined) return;
  const parts = [...(byTurn.get(part.turnId)?.parts ?? [])];
  const at = parts.findIndex(existing => existing.seq > part.seq);
  parts.splice(at === -1 ? parts.length : at, 0, part);
  // `set` on a key the map already holds leaves its position alone, so turns
  // keep the order their first part arrived in; only the turn the part landed
  // in gets a new entry, so a reader can compare identities to spot new news.
  byTurn.set(part.turnId, { turnId: part.turnId, parts });
  if (byTurn.size > MAX_TURNS) {
    const oldest = byTurn.keys().next().value;
    if (oldest !== undefined) byTurn.delete(oldest);
  }
  feed = [...byTurn.values()];
  notify();
}

export function subscribeWorkbench(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function workbenchFeed(): readonly WorkbenchTurn[] {
  return feed;
}

/** Test/host teardown: forget every turn. */
export function resetWorkbench(): void {
  byTurn.clear();
  feed = NO_TURNS;
  notify();
}

/** Every turn the harness has reported diagnostics for, oldest turn first. */
export function useWorkbenchFeed(): readonly WorkbenchTurn[] {
  return useSyncExternalStore(subscribeWorkbench, workbenchFeed, workbenchFeed);
}
