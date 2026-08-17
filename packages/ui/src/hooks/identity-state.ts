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

/** The page signal: the host announces "who is signed in changed" (sign-in,
 *  sign-out, workspace switch). Every gated poller re-checks on it. */
export const IDENTITY_CHANGED_EVENT = "vendo:identity-changed";

/** The one refusal that means "this visitor has no identity here". */
export function isForbiddenError(reason: unknown): boolean {
  return reason instanceof VendoError && reason.code === "forbidden";
}

export interface IdentityState {
  forbidden(): boolean;
  /** Record a failed wire read; only a forbidden refusal moves the latch. */
  note(reason: unknown): void;
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

function createState(): IdentityState {
  let forbidden = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean): void => {
    if (forbidden === next) return;
    forbidden = next;
    for (const listener of [...listeners]) listener();
  };
  // One listener per state, alive as long as the client is — page-scoped, like
  // the client itself. Guarded for SSR.
  if (typeof window !== "undefined") {
    window.addEventListener(IDENTITY_CHANGED_EVENT, () => set(false));
  }
  return {
    forbidden: () => forbidden,
    note: (reason) => {
      if (isForbiddenError(reason)) set(true);
    },
    clear: () => set(false),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
