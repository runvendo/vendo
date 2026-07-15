/** Per-principal connected accounts transport (04-actions §3). */
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";
import type { ConnectionAccount } from "../wire-types.js";

export function useConnections(): {
  connections: ConnectionAccount[];
  refresh(): Promise<void>;
  disconnect(id: string, connector?: string): Promise<void>;
} {
  const { client } = useVendoContext();
  const [connections, setConnections] = useState<ConnectionAccount[]>([]);
  const refresh = useCallback(async () => setConnections(await client.connections.list()), [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const disconnect = useCallback(
    async (id: string, connector?: string) => {
      await client.connections.disconnect(id, connector);
      await refresh();
    },
    [client, refresh],
  );

  return { connections, refresh, disconnect };
}
