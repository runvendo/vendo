/** Per-principal connected accounts transport (04-actions §3). */
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";
import type { ConnectionAccount } from "../wire-types.js";

export function useConnections(options?: PollOptions): {
  connections: ConnectionAccount[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  disconnect(id: string, connector?: string): Promise<void>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.connections.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as ConnectionAccount[], options);

  const disconnect = useCallback(
    async (id: string, connector?: string) => {
      await client.connections.disconnect(id, connector);
      await refresh();
    },
    [client, refresh],
  );

  return { connections: data, error, isLoading, refresh, disconnect };
}
