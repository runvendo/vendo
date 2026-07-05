/**
 * `swr` shim. `useSWR(key, fetcher)` resolves from data the host injected into
 * the sandbox (`window.__vendoAnchorData` — the anchor's live payload and
 * declared query results), keyed by the SWR key. The FETCHER ARGUMENT IS NEVER
 * INVOKED — network egress stays jailed. `mutate` is a no-op unless a declared
 * query backs the key (not in v1). Default export mirrors `swr`.
 */
interface AnchorDataWindow {
  __vendoAnchorData?: Record<string, unknown>;
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
