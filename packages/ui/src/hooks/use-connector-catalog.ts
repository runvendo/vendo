/** The connect dock's effective catalog: the host's explicit `connectors`
    prop when it passed one, else the wire's auto catalog — everything the
    server-side connectors advertise (`GET /connections/catalog`). */
import { useEffect, useState } from "react";
import type { VendoClient } from "../client.js";
import { useVendoContext, type ConnectorOption } from "../context.js";

/** One catalog fetch per client instance per page load, shared by every
    surface that resolves the catalog (dock button, tray, connect card,
    accounts panel). The catalog is host-level and dashboard-static, so
    staleness within a page visit is fine. */
const catalogByClient = new WeakMap<VendoClient, Promise<ConnectorOption[]>>();

function fetchCatalog(client: VendoClient): Promise<ConnectorOption[]> {
  const cached = catalogByClient.get(client);
  if (cached) return cached;
  const promise = client.connections.catalog().then(
    (entries) => entries.map((entry) => ({
      toolkit: entry.toolkit,
      connector: entry.connector,
      ...(entry.label === undefined ? {} : { label: entry.label }),
    })),
    (reason: unknown) => {
      // A failed fetch hides the dock rather than breaking the thread; warn
      // (never silently) and forget the promise so a later mount retries.
      catalogByClient.delete(client);
      console.warn("[vendo] connector catalog fetch failed; the connect dock stays hidden:", reason);
      return [];
    },
  );
  catalogByClient.set(client, promise);
  return promise;
}

export function useConnectorCatalog(): {
  options: ConnectorOption[];
  /** False only while the auto catalog is in flight — surfaces that must not
      flash (the dock button) stay hidden until resolution. */
  resolved: boolean;
} {
  const { client, connectors } = useVendoContext();
  const auto = connectors === "auto";
  const [fetched, setFetched] = useState<ConnectorOption[]>();

  useEffect(() => {
    if (!auto) return;
    let cancelled = false;
    void fetchCatalog(client).then((options) => {
      if (!cancelled) setFetched(options);
    });
    return () => {
      cancelled = true;
    };
  }, [auto, client]);

  if (!auto) return { options: connectors, resolved: true };
  return { options: fetched ?? [], resolved: fetched !== undefined };
}
