/**
 * `swr` shim. `useSWR(key, fetcher)` resolves from data the host injected into
 * the sandbox (`window.__vendoAnchorData` — the anchor's live payload and
 * declared query results), keyed by the SWR key. The FETCHER ARGUMENT IS NEVER
 * INVOKED — network egress stays jailed. `mutate` is a no-op unless a declared
 * query backs the key (not in v1). Default export mirrors `swr`.
 */
import { createElement, Fragment, type ReactElement, type ReactNode } from "react";

interface AnchorDataWindow {
  __vendoAnchorData?: Record<string, unknown>;
}

function anchorStore(): Record<string, unknown> {
  const win = globalThis as unknown as AnchorDataWindow;
  return (win.__vendoAnchorData ??= {});
}

export interface SWRResponse<T> {
  data: T | undefined;
  error: undefined;
  isLoading: boolean;
  isValidating: boolean;
  mutate: () => Promise<T | undefined>;
}

/** SWR conditional-fetching: a null/undefined/false key, or a function key that
 *  throws/returns a falsy key (a dependency isn't ready), means "don't fetch".
 *  Returns `{ skip: true }` for those; otherwise the cache key (or undefined if
 *  the key shape carries no lookup string). */
function resolveKey(key: unknown): { skip: true } | { skip: false; key: string | undefined } {
  if (typeof key === "function") {
    try {
      key = (key as () => unknown)();
    } catch {
      return { skip: true }; // dependency not ready → don't fetch
    }
  }
  // null/undefined/false are all "disabled key" idioms: useSWR(ready && "/x").
  if (key == null || key === false) return { skip: true };
  if (typeof key === "string") return { skip: false, key };
  if (Array.isArray(key) && typeof key[0] === "string") return { skip: false, key: key[0] };
  return { skip: false, key: undefined };
}

export default function useSWR<T = unknown>(key: unknown, _fetcher?: unknown): SWRResponse<T> {
  // _fetcher is intentionally ignored — calling it would breach the egress jail.
  const resolved = resolveKey(key);
  if (resolved.skip) {
    // Not fetching: no spinner. Without this a null/conditional key spun forever.
    return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: async () => undefined };
  }
  const store = (globalThis as unknown as AnchorDataWindow).__vendoAnchorData ?? {};
  const data = resolved.key !== undefined ? (store[resolved.key] as T | undefined) : undefined;
  return {
    data,
    error: undefined,
    isLoading: data === undefined,
    isValidating: false,
    mutate: async () => data,
  };
}

export { useSWR };

function keyString(key: unknown): string | undefined {
  if (typeof key === "string") return key;
  if (Array.isArray(key) && typeof key[0] === "string") return key[0];
  return undefined;
}

/** Global `mutate`, wired to the same anchor-data cache `useSWR` reads. Supports:
 *   - `mutate(key, data)` — write `data` under the key, resolve with it;
 *   - `mutate(key)` — the revalidate form: no fetcher to run, so resolve with
 *     the CURRENT cached value rather than silently dropping;
 *   - `mutate(matcherFn[, data])` — predicate/broadcast form: apply the matcher
 *     to every cache key, optionally write `data` to matches, resolve with the
 *     array of matched values.
 *  (No reactive re-render here — `useSWR` reads synchronously each render.) */
export function mutate<T = unknown>(
  keyOrMatcher: unknown,
  data?: T,
  _opts?: unknown,
): Promise<T | undefined | Array<T | undefined>> {
  const store = anchorStore();
  const hasData = data !== undefined;

  if (typeof keyOrMatcher === "function") {
    const matcher = keyOrMatcher as (key: string) => unknown;
    const results: Array<T | undefined> = [];
    for (const k of Object.keys(store)) {
      let matches = false;
      try {
        matches = Boolean(matcher(k));
      } catch {
        matches = false;
      }
      if (!matches) continue;
      if (hasData) store[k] = data;
      results.push(store[k] as T | undefined);
    }
    return Promise.resolve(results);
  }

  const key = keyString(keyOrMatcher);
  if (key === undefined) return Promise.resolve(undefined);
  if (hasData) store[key] = data;
  return Promise.resolve(store[key] as T | undefined);
}

export interface SWRConfiguration {
  mutate: typeof mutate;
  cache: Map<string, unknown>;
}

/** `useSWRConfig()` — a config object with a working `mutate` and sane defaults. */
export function useSWRConfig(): SWRConfiguration {
  return { mutate, cache: new Map() };
}

/** `SWRConfig` — a passthrough provider. There is no live config in the sandbox,
 *  so it simply renders its children. */
export function SWRConfig({ children }: { value?: unknown; children?: ReactNode }): ReactElement {
  return createElement(Fragment, null, children);
}

/** `preload(key, fetcher)` — a safe no-op returning a resolved promise. The
 *  fetcher is never invoked (egress stays jailed); data arrives via anchorData. */
export function preload(_key: unknown, _fetcher?: unknown): Promise<undefined> {
  return Promise.resolve(undefined);
}
