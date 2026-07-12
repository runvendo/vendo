/** App collection transport (08-ui §3). */
import type { AppDocument, AppId } from "@vendoai/core";
import { useCallback, useEffect, useState } from "react";
import { useVendoContext } from "../context.js";

export function useApps(): {
  apps: AppDocument[];
  create(prompt: string): Promise<AppDocument>;
  remove(id: AppId): Promise<void>;
  fork(id: AppId): Promise<AppDocument>;
} {
  const { client } = useVendoContext();
  const [apps, setApps] = useState<AppDocument[]>([]);
  const refresh = useCallback(async () => setApps(await client.apps.list()), [client]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  const create = useCallback(
    async (prompt: string) => {
      const app = await client.apps.create({ prompt });
      await refresh();
      return app;
    },
    [client, refresh],
  );
  const remove = useCallback(
    async (id: AppId) => {
      await client.apps.delete(id);
      await refresh();
    },
    [client, refresh],
  );
  const fork = useCallback(
    async (id: AppId) => {
      const app = await client.apps.fork(id);
      await refresh();
      return app;
    },
    [client, refresh],
  );

  return { apps, create, remove, fork };
}
