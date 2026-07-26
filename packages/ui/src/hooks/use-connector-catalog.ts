/** The connect dock's effective catalog: the host's explicit `connectors`
    prop when it passed one, else the wire's auto catalog — everything the
    server-side connectors advertise (`GET /connections/catalog`). */
import { useCallback, useEffect, useState } from "react";
import type { VendoClient } from "../client.js";
import { useVendoContext, type ConnectorOption } from "../context.js";

type CatalogResult = { options: ConnectorOption[]; failed: boolean };

/** One catalog fetch per client instance per page load, shared by every
    surface that resolves the catalog (dock button, tray, connect card,
    accounts panel). The catalog is host-level and dashboard-static, so
    staleness within a page visit is fine. */
const catalogByClient = new WeakMap<VendoClient, Promise<CatalogResult>>();

function fetchCatalog(client: VendoClient): Promise<CatalogResult> {
  const cached = catalogByClient.get(client);
  if (cached) return cached;
  const promise = client.connections.catalog().then(
    (entries) => ({
      options: entries.map((entry) => ({
        toolkit: entry.toolkit,
        connector: entry.connector,
        ...(entry.label === undefined ? {} : { label: entry.label }),
      })),
      failed: false,
    }),
    (reason: unknown) => {
      // A failed fetch no longer hides the dock (2026-07 demo feedback — the
      // button vanished whenever /connections wasn't configured): the button
      // stays and the tray shows an honest error state with a retry. Warn
      // (never silently) and forget the promise so a retry refetches.
      catalogByClient.delete(client);
      console.warn("[vendo] connector catalog fetch failed; the connect tray will offer a retry:", reason);
      return { options: [], failed: true };
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
  /** True when the catalog came from the host's explicit `connectors` prop
      (an explicit `[]` means "no connectors, ever" — the dock honors it). */
  explicit: boolean;
  /** True when the auto catalog fetch FAILED (wire error) — distinct from a
      catalog that genuinely resolved to nothing. */
  failed: boolean;
  /** Re-runs a failed auto fetch (no-op for explicit catalogs). */
  retry: () => void;
} {
  const { client, connectors } = useVendoContext();
  const auto = connectors === "auto";
  // Keyed by client so a provider that swaps clients never shows the
  // previous host's catalog while the replacement fetch is in flight.
  const [fetched, setFetched] = useState<{ client: VendoClient; result: CatalogResult }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!auto) return;
    let cancelled = false;
    void fetchCatalog(client).then((result) => {
      if (!cancelled) setFetched({ client, result });
    });
    return () => {
      cancelled = true;
    };
  }, [auto, client, attempt]);

  const retry = useCallback(() => {
    // The failed promise already evicted itself from the cache; clearing the
    // held result flips `resolved` back to false while the refetch runs.
    setFetched(undefined);
    setAttempt(count => count + 1);
  }, []);

  if (!auto) return { options: connectors, resolved: true, explicit: true, failed: false, retry };
  const current = fetched !== undefined && fetched.client === client ? fetched.result : undefined;
  return {
    options: current?.options ?? [],
    resolved: current !== undefined,
    explicit: false,
    failed: current?.failed === true,
    retry,
  };
}
