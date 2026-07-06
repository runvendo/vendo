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

/** SWR conditional-fetching: a null/undefined key, or a function key that
 *  throws/returns null (a dependency isn't ready), means "don't fetch". Returns
 *  `{ skip: true }` for those; otherwise the cache key (or undefined if the key
 *  shape carries no lookup string). */
function resolveKey(key: unknown): { skip: true } | { skip: false; key: string | undefined } {
  if (typeof key === "function") {
    try {
      key = (key as () => unknown)();
    } catch {
      return { skip: true }; // dependency not ready → don't fetch
    }
  }
  if (key == null) return { skip: true }; // conditional-fetch idiom → don't fetch
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

/** Global `mutate`. Wired to the same anchor-data cache `useSWR` reads: when
 *  `data` is supplied it writes it under the key so a subsequent `useSWR(key)`
 *  sees the new value, then resolves with it. With no data it is a safe resolved
 *  no-op (there is no revalidation — the fetcher is never run). */
export function mutate<T = unknown>(key: unknown, data?: T): Promise<T | undefined> {
  if (typeof key === "string" && data !== undefined) {
    anchorStore()[key] = data;
  }
  return Promise.resolve(data);
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
