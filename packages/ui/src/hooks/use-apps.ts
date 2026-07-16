/** App collection transport (08-ui §3). */
import type { AppDocument, AppId } from "@vendoai/core";
import { useCallback } from "react";
import { useVendoContext } from "../context.js";
import { type PollOptions, useResource } from "./use-resource.js";

export function useApps(options?: PollOptions): {
  /** Back-compat alias for `data` (contract §3). */
  apps: AppDocument[];
  data: AppDocument[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  create(prompt: string): Promise<AppDocument>;
  remove(id: AppId): Promise<void>;
  fork(id: AppId): Promise<AppDocument>;
  exportApp(id: AppId): Promise<Uint8Array>;
  importApp(bytes: Uint8Array): Promise<AppDocument>;
} {
  const { client } = useVendoContext();
  const list = useCallback(() => client.apps.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as AppDocument[], options);

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
  const exportApp = useCallback((id: AppId) => client.apps.exportApp(id), [client]);
  const importApp = useCallback(
    async (bytes: Uint8Array) => {
      const app = await client.apps.importApp(bytes);
      await refresh();
      return app;
    },
    [client, refresh],
  );

  return { apps: data, data, error, isLoading, refresh, create, remove, fork, exportApp, importApp };
}
