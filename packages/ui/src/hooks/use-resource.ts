/** Shared fetch lifecycle for the headless data hooks (08-ui §3).
 *
 * Gives every collection hook the same `{ data, error, isLoading, refresh }`
 * shape so headless consumers can tell empty / failed / loading apart — the
 * initial fetch no longer swallows failure into a silent `undefined`. Polling
 * is opt-in: pass `pollMs` and the resource re-fetches on that cadence without
 * a remount, so a newly-pending approval (or thread, run, …) appears on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { IDENTITY_CHANGED_EVENT, isForbiddenError } from "./identity-state.js";

/** Opt-in polling knob accepted by every collection hook. */
export interface PollOptions {
  /** When set (> 0), re-fetch on this millisecond cadence. Off by default. */
  pollMs?: number;
}

export interface Resource<T> {
  data: T;
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/** A tab nobody is looking at costs the deployment nothing — the rule the shared
    approvals feed has always followed, and now every polled resource does. */
function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Drive one async source into a `{ data, error, isLoading, refresh }` view.
 *
 * `fetcher` must be memoised by the caller (stable across renders while its
 * inputs are unchanged) — refresh, the mount fetch, and the poll all key off
 * its identity. A per-call generation guard drops out-of-order and post-unmount
 * responses so overlapping refreshes (poll + manual + post-mutation) never
 * clobber newer state. `isLoading` reflects only the very first load, so a
 * background poll or refresh never flickers a consumer's initial skeleton. */
export function useResource<T>(fetcher: () => Promise<T>, initial: T, { pollMs }: PollOptions = {}): Resource<T> {
  const [data, setData] = useState<T>(initial);
  const [error, setError] = useState<Error>();
  const [isLoading, setIsLoading] = useState(true);
  const generationRef = useRef(0);
  const loadedRef = useRef(false);
  // H2-E / #1372 — a forbidden refusal is a full stop for the POLL, not a
  // transient to retry: on a preset-authed deployment a signed-out visitor's
  // every read correctly 403s, and re-asking on a cadence cannot change the
  // answer. Manual refresh() still works (an explicit call is its own signal),
  // a success clears the latch, and the page's identity event wakes the poll.
  const forbiddenRef = useRef(false);

  const refresh = useCallback(async () => {
    const generation = (generationRef.current += 1);
    if (!loadedRef.current) setIsLoading(true);
    try {
      const next = await fetcher();
      if (generation !== generationRef.current) return;
      forbiddenRef.current = false;
      setData(next);
      setError(undefined);
      loadedRef.current = true;
    } catch (reason) {
      if (generation !== generationRef.current) return;
      if (isForbiddenError(reason)) forbiddenRef.current = true;
      setError(asError(reason));
    } finally {
      if (generation === generationRef.current) setIsLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    void refresh();
    // Bump the generation on unmount / fetcher change so an in-flight response
    // can't land on a stale (or torn-down) resource.
    return () => {
      generationRef.current += 1;
    };
  }, [refresh]);

  // Self-scheduling rather than setInterval: the next poll is armed only after
  // the current refresh settles, so a slow request (pollMs < latency) can never
  // stack overlapping fetches that stale each other out (and leave the first
  // load stuck loading).
  //
  // A hidden tab is skipped, not stopped: the cadence keeps ticking so there is
  // no restart to get wrong, and coming back re-reads on the spot rather than
  // leaving stale rows up for another whole interval.
  useEffect(() => {
    if (pollMs === undefined || pollMs <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      // Forbidden skips the fetch, not the cadence — no restart machinery, and
      // zero requests while latched (the field failure was endless 403 spam).
      if (!hidden() && !forbiddenRef.current) await refresh();
      if (!cancelled) timer = setTimeout(() => void tick(), pollMs);
    };
    timer = setTimeout(() => void tick(), pollMs);
    const onVisible = () => {
      // A tab switch is not a sign-in: the latch holds through it.
      if (!hidden() && !cancelled && !forbiddenRef.current) void refresh();
    };
    const onIdentity = () => {
      forbiddenRef.current = false;
      if (!cancelled) void refresh();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    if (typeof window !== "undefined") window.addEventListener(IDENTITY_CHANGED_EVENT, onIdentity);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
      if (typeof window !== "undefined") window.removeEventListener(IDENTITY_CHANGED_EVENT, onIdentity);
    };
  }, [pollMs, refresh]);

  return { data, error, isLoading, refresh };
}
