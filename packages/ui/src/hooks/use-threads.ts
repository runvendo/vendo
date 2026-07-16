/** Thread collection transport (08-ui §3) — headless parity for the thread
 * list that VendoPage previously reached only by calling the client directly. */
import type { ThreadId } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { Thread, ThreadSummary } from "../wire-types.js";

export function useThreads(options?: PollOptions): {
  /** Back-compat-shaped alias for `data` (matches the other collection hooks). */
  threads: ThreadSummary[];
  data: ThreadSummary[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  get(id: ThreadId): Promise<Thread>;
  remove(id: ThreadId): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.threads.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as ThreadSummary[], options);

  const get = useCallback((id: ThreadId) => client.threads.get(id), [client]);
  const remove = useCallback(
    async (id: ThreadId) => {
      await client.threads.delete(id);
      await refresh();
    },
    [client, refresh],
  );

  return { threads: data, data, error, isLoading, refresh, get, remove };
}
