/**
 * Build contract §1.3 — the harness's own state. Opaque to us, persisted by us,
 * disposable: correctness never depends on the harness's copy, because the truth
 * is ours (architecture §3, "Harness state").
 */
import type { ThreadId, TurnState } from "@vendoai/core";
import type { UIMessage } from "ai";
import { jsonEqual } from "./json-equal.js";

/**
 * Where an opaque `turn.state` lives between turns.
 *
 * ONE slot per thread, carrying the name of the harness that owns it. §1.3 says a
 * harness swap CLEARS the state — so a swap must destroy it, not shadow it behind
 * a per-harness key. Keying by harness would let a stale session resurrect when
 * the user swapped back, handing a thinker a session id that no longer describes
 * a conversation that has moved on without it.
 */
export interface HarnessStateStore {
  /** The stored state iff it belongs to `harnessName`; a foreign owner CLEARS. */
  get(threadId: ThreadId, harnessName: string): Promise<string | undefined>;
  /** `undefined` deletes. */
  set(threadId: ThreadId, harnessName: string, value: string | undefined): Promise<void>;
  /** Drop the thread's state whoever owns it (an arbitrary history edit). */
  clear(threadId: ThreadId): Promise<void>;
}

/** The process-lifetime reference implementation, for compositions with no store
 *  (and for suites). A session id is disposable by contract, so losing it on
 *  restart costs a re-seed, never correctness. */
export function memoryHarnessStateStore(): HarnessStateStore {
  const values = new Map<ThreadId, { harness: string; value: string }>();
  return {
    async get(threadId, harnessName) {
      const stored = values.get(threadId);
      if (stored === undefined) return undefined;
      if (stored.harness === harnessName) return stored.value;
      // A different thinker holds this conversation now: §1.3's clearing rule.
      // Destroying it here (rather than just declining to hand it over) is what
      // stops a swap-back from resurrecting a session the thread has outgrown.
      values.delete(threadId);
      return undefined;
    },
    async set(threadId, harnessName, value) {
      if (value === undefined) values.delete(threadId);
      else values.set(threadId, { harness: harnessName, value });
    },
    async clear(threadId) {
      values.delete(threadId);
    },
  };
}

export type PendingState = { value: string | undefined; dirty: boolean };

/** The §1.3 handle a harness holds for one turn. Writes are buffered and land
 *  once, at turn end — a turn that sets a session id ten times costs one row. */
export function createTurnState(initial: string | undefined): TurnState & { pending(): PendingState } {
  let value = initial;
  let dirty = false;
  return {
    get: () => value,
    set(next) {
      value = next;
      dirty = true;
    },
    clear() {
      value = undefined;
      dirty = true;
    },
    pending: () => ({ value, dirty }),
  };
}

/**
 * How the incoming transcript relates to the one we persisted.
 *
 * `arbitrary-edit` is the only one that clears `turn.state` (§1.3): the harness's
 * native session no longer describes the conversation we hold. A
 * `prefix-truncation` is a retry of an edited message, which the harness rewinds
 * natively, so its session survives.
 */
export type HistoryChange = "append" | "prefix-truncation" | "arbitrary-edit";

export function classifyHistory(
  persisted: readonly UIMessage[],
  incoming: readonly UIMessage[],
): HistoryChange {
  const overlap = Math.min(persisted.length, incoming.length);
  for (let index = 0; index < overlap; index += 1) {
    const before = persisted[index]!;
    const after = incoming[index]!;
    if (before.id !== after.id || before.role !== after.role || !jsonEqual(before.parts, after.parts, true)) {
      return "arbitrary-edit";
    }
  }
  return incoming.length < persisted.length ? "prefix-truncation" : "append";
}
