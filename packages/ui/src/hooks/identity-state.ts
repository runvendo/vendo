/**
 * The page-wide answer to "did the wire refuse this visitor for missing
 * identity?" — one latch per client (H2-E / #1372).
 *
 * On a preset-authed deployment every wire call for a signed-out visitor
 * correctly answers 403 (`VendoError` code `forbidden` — branch on the CODE,
 * never the status: `blocked` rides 403 too). The refusal is right; retrying
 * it forever is not. Pollers consult this latch and go quiet the first time
 * the wire says forbidden, and everything wakes together when the page says
 * identity changed — the host dispatches {@link IDENTITY_CHANGED_EVENT} after
 * an SPA sign-in (a full-page redirect remounts everything anyway) — or when
 * any wire read succeeds again.
 *
 * Internal on purpose (the HistoryPicker precedent): the latch is plumbing,
 * not API. Keyed by client identity so a page holding several clients (the
 * overlay's and each embed's) latches per wire, and registered listeners live
 * exactly as long as their client does.
 */
import { VendoError } from "@vendoai/core";
import { useSyncExternalStore } from "react";

/** The page signal: the host announces "who is signed in changed" (sign-in,
 *  sign-out, workspace switch). Every gated poller re-checks on it. */
export const IDENTITY_CHANGED_EVENT = "vendo:identity-changed";

/** The one refusal that means "this visitor has no identity here". */
export function isForbiddenError(reason: unknown): boolean {
  return reason instanceof VendoError && reason.code === "forbidden";
}

export interface IdentityState {
  forbidden(): boolean;
  /** The current open-signal generation — bumped by every `clear()` and every
   *  identity event. Capture it when a request BEGINS and pass it to `note`:
   *  a refusal from before the latest open signal is stale evidence (greptile
   *  on #1445: an in-flight warm's 403 landing after sign-in re-closed the
   *  latch and took the composer away from a signed-in visitor). */
  epoch(): number;
  /** Record a failed wire read; only a forbidden refusal moves the latch, and
   *  only when `since` (the epoch at request start) is still current. */
  note(reason: unknown, since?: number): void;
  /** A successful wire read (or the page signal) — the latch opens. */
  clear(): void;
  subscribe(listener: () => void): () => void;
}

const states = new WeakMap<object, IdentityState>();

export function identityState(client: object): IdentityState {
  let state = states.get(client);
  if (state === undefined) {
    state = createState();
    states.set(client, state);
  }
  return state;
}

/** React view of the latch — the overlay's signed-out panel reads this. SSR
 *  and the first client render answer false: the latch can only close after a
 *  real wire read, so hydration always agrees with the server. */
export function useSignedOut(client: object): boolean {
  const state = identityState(client);
  return useSyncExternalStore(state.subscribe, state.forbidden, () => false);
}

function createState(): IdentityState {
  let forbidden = false;
  let epoch = 0;
  const listeners = new Set<() => void>();
  const set = (next: boolean): void => {
    if (forbidden === next) return;
    forbidden = next;
    for (const listener of [...listeners]) listener();
  };
  // Every open signal — a success or the page event — starts a new epoch,
  // whether or not the latch was closed: it invalidates the refusals of every
  // request already in flight when it fired.
  const open = (): void => {
    epoch += 1;
    set(false);
  };
  // One listener per state, alive as long as the client is — page-scoped, like
  // the client itself. Guarded for SSR.
  if (typeof window !== "undefined") {
    window.addEventListener(IDENTITY_CHANGED_EVENT, open);
  }
  return {
    forbidden: () => forbidden,
    epoch: () => epoch,
    note: (reason, since) => {
      if (since !== undefined && since !== epoch) return;
      if (isForbiddenError(reason)) set(true);
    },
    clear: open,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
