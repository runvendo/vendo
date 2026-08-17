/** App collection transport (08-ui §3). */
import {
  type AppDocument,
  type AppId,
} from "@vendoai/core";
import { useCallback, useSyncExternalStore } from "react";
import { useVendoProvider } from "../context.js";
import type { AppListRow } from "../wire-types.js";
import { APPS_LOADING, appsFeed } from "./apps-feed.js";
import { type PollOptions } from "./use-resource.js";

/** SSR / first-render snapshot, stable across calls. */
const loadingSnapshot = () => APPS_LOADING;

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
} {
  const { client } = useVendoProvider();
  // H15 — one apps poller per client (apps-feed), shared with the launcher's
  // dot: this hook and the pill reading the unseen count off the same rows cost
  // ONE request between them, and cannot disagree in front of anyone.
  const feed = appsFeed(client);
  const pollMs = options?.pollMs ?? 0;
  const subscribe = useCallback((listener: () => void) => feed.subscribe(listener, pollMs), [feed, pollMs]);
  const { data, error, isLoading } = useSyncExternalStore(subscribe, feed.read, loadingSnapshot);
  const refresh = useCallback(() => feed.refresh(), [feed]);

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

  return { apps: data, error, isLoading, refresh, create, remove, fork, exportApp, importApp };
}
