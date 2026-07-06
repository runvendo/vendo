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

function resolveKey(key: unknown): string | undefined {
  if (typeof key === "string") return key;
  if (Array.isArray(key) && typeof key[0] === "string") return key[0];
  return undefined;
}

export default function useSWR<T = unknown>(key: unknown, _fetcher?: unknown): SWRResponse<T> {
  // _fetcher is intentionally ignored — calling it would breach the egress jail.
  const store = (globalThis as unknown as AnchorDataWindow).__vendoAnchorData ?? {};
  const resolved = resolveKey(key);
  const data = resolved !== undefined ? (store[resolved] as T | undefined) : undefined;
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
