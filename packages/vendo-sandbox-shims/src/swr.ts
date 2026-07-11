/**
 * `swr` shim. The FETCHER ARGUMENT IS NEVER INVOKED — network egress stays
 * jailed. Without a configured fallback, data resolves gracefully to
 * undefined. Default export mirrors `swr`.
 */
import { createContext, createElement, useContext, type ReactElement, type ReactNode } from "react";

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
  let data: T | undefined;
  if (resolved.key !== undefined && resolved.key in config.fallback) {
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

/** Global `mutate` is a safe no-op because the sandbox has no data channel and
 * cannot revalidate over the network. */
export function mutate<T = unknown>(
  _keyOrMatcher: unknown,
  _data?: T,
  _opts?: unknown,
): Promise<T | undefined | Array<T | undefined>> {
  return Promise.resolve(undefined);
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
 *  fetcher is never invoked (egress stays jailed). */
export function preload(_key: unknown, _fetcher?: unknown): Promise<undefined> {
  return Promise.resolve(undefined);
}
