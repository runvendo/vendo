/** App collection transport (08-ui §3). */
import {
  type AppDocument,
  type AppId,
} from "@vendoai/core";
import { useCallback, useEffect } from "react";
import { useVendoProvider } from "../context.js";
import type { AppListRow } from "../wire-types.js";
import { type PollOptions, useResource } from "./use-resource.js";

/** How many apps have never rendered for this person — what the launcher's dot
 *  reads. Published by the list fetch every surface already makes (the row
 *  carries `unseen`), so the pill costs no request of its own and there is no
 *  second poller to keep in step with this one. */
let unseen = 0;
const listeners = new Set<() => void>();

export const unseenApps = (): number => unseen;

export const subscribeUnseenApps = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useApps(options?: PollOptions): {
  apps: AppListRow[];
  error: Error | undefined;
  isLoading: boolean;
  refresh(): Promise<void>;
  create(prompt: string): Promise<AppDocument>;
  remove(id: AppId): Promise<void>;
  fork(id: AppId): Promise<AppDocument>;
  exportApp(id: AppId): Promise<Uint8Array>;
  importApp(bytes: Uint8Array): Promise<AppDocument>;
  /** The arrival mark for a surface that LISTS an app without rendering it —
   *  rendering marks it on its own, server-side. Idempotent. */
  markSeen(id: AppId): Promise<void>;
} {
  const { client } = useVendoProvider();
  const list = useCallback(() => client.apps.list(), [client]);
  const { data, error, isLoading, refresh } = useResource(list, [] as AppListRow[], options);

  useEffect(() => {
    const next = data.filter((app) => app.unseen === true).length;
    if (next === unseen) return;
    unseen = next;
    for (const listener of listeners) listener();
  }, [data]);

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
  const markSeen = useCallback(
    async (id: AppId) => {
      await client.apps.seen(id);
      await refresh();
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

  return { apps: data, error, isLoading, refresh, create, remove, fork, exportApp, importApp, markSeen };
}
