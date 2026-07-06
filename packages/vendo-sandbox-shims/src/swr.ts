/**
 * `swr` shim. `useSWR(key, fetcher)` resolves from data the host injected into
 * the sandbox (`window.__vendoAnchorData` — the anchor's live payload and
 * declared query results), keyed by the SWR key. The FETCHER ARGUMENT IS NEVER
 * INVOKED — network egress stays jailed. `mutate` is a no-op unless a declared
 * query backs the key (not in v1). Default export mirrors `swr`.
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

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
  const config = useConfig();
  if (resolved.skip) {
    // Not fetching: no spinner. Without this a null/conditional key spun forever.
    return { data: undefined, error: undefined, isLoading: false, isValidating: false, mutate: async () => undefined };
  }
  const store = (globalThis as unknown as AnchorDataWindow).__vendoAnchorData ?? {};
  // Precedence: live anchor data > provider per-key fallback > provider
  // fallbackData default. Fallback keeps a component out of a permanent spinner
  // when the host hasn't injected that key yet.
  let data = resolved.key !== undefined ? (store[resolved.key] as T | undefined) : undefined;
  if (data === undefined && resolved.key !== undefined && resolved.key in config.fallback) {
    data = config.fallback[resolved.key] as T | undefined;
  }
  if (data === undefined) data = config.fallbackData as T | undefined;
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

/** The provider config threaded through `SWRConfig`. `fallback`/`fallbackData`
 *  seed `useSWR` and `cache`/`mutate` are shared so `useSWRConfig` sees them. */
export interface SWRProviderValue extends SWRConfiguration {
  fallback: Record<string, unknown>;
  fallbackData: unknown;
}

const DEFAULT_CONFIG: SWRProviderValue = {
  fallback: {},
  fallbackData: undefined,
  cache: new Map(),
  mutate,
};

const SWRConfigContext = createContext<SWRProviderValue>(DEFAULT_CONFIG);

/** Read the active `SWRConfig`. Tolerates being called outside a React render —
 *  the shim's hooks are also invoked directly (e.g. in tests / non-render code)
 *  — by returning the defaults rather than throwing. */
function useConfig(): SWRProviderValue {
  try {
    return useContext(SWRConfigContext);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export interface SWRConfigValue {
  fallback?: Record<string, unknown>;
  fallbackData?: unknown;
  provider?: () => Map<string, unknown>;
}

/** `useSWRConfig()` — the active provider config (shared `cache` + `mutate`), so
 *  callers no longer get a throwaway fresh Map each call. */
export function useSWRConfig(): SWRConfiguration {
  return useConfig();
}

/** `SWRConfig` — provides its `value` (merged over any parent) through context
 *  so `useSWR`/`useSWRConfig` see the fallback data, shared cache, and mutate. */
export function SWRConfig({
  value,
  children,
}: {
  value?: SWRConfigValue;
  children?: ReactNode;
}): ReactElement {
  const parent = useConfig();
  const merged: SWRProviderValue = {
    fallback: { ...parent.fallback, ...(value?.fallback ?? {}) },
    fallbackData: value?.fallbackData !== undefined ? value.fallbackData : parent.fallbackData,
    cache: typeof value?.provider === "function" ? value.provider() : parent.cache,
    mutate,
  };
  return createElement(SWRConfigContext.Provider, { value: merged }, children);
}

/** `preload(key, fetcher)` — a safe no-op returning a resolved promise. The
 *  fetcher is never invoked (egress stays jailed); data arrives via anchorData. */
export function preload(_key: unknown, _fetcher?: unknown): Promise<undefined> {
  return Promise.resolve(undefined);
}
