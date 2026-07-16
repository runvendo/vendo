/** Shared fetch lifecycle for the headless data hooks (08-ui §3).
 *
 * Gives every collection hook the same `{ data, error, isLoading, refresh }`
 * shape so headless consumers can tell empty / failed / loading apart — the
 * initial fetch no longer swallows failure into a silent `undefined`. Polling
 * is opt-in: pass `pollMs` and the resource re-fetches on that cadence without
 * a remount, so a newly-pending approval (or thread, run, …) appears on its own.
 */
import { useCallback, useEffect, useRef, useState } from "react";

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

  const refresh = useCallback(async () => {
    const generation = (generationRef.current += 1);
    if (!loadedRef.current) setIsLoading(true);
    try {
      const next = await fetcher();
      if (generation !== generationRef.current) return;
      setData(next);
      setError(undefined);
      loadedRef.current = true;
    } catch (reason) {
      if (generation !== generationRef.current) return;
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

  useEffect(() => {
    if (pollMs === undefined || pollMs <= 0) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, refresh]);

  return { data, error, isLoading, refresh };
}
