/**
 * The connections store: which toolkits are connected, i.e. what the agent
 * ingests. Kept free of Composio imports so options/typing can depend on it
 * without pulling server modules.
 */
import type { IntegrationCatalogEntry } from "./options";

export interface ConnectionsStore {
  list(): Array<IntegrationCatalogEntry & { connected: boolean }>;
  connect(id: string): void;
  disconnect(id: string): void;
  connectedToolkits(): string[];
}

/** In-memory connected-toolkit set — the single source of truth for what the
 *  agent ingests. Everything starts DISCONNECTED on boot. */
export function createConnectionsStore(catalog: IntegrationCatalogEntry[]): ConnectionsStore {
  const validIds = new Set(catalog.map((c) => c.id));
  const connected = new Set<string>();
  return {
    list: () => catalog.map((c) => ({ ...c, connected: connected.has(c.id) })),
    connect: (id) => {
      if (validIds.has(id)) connected.add(id);
    },
    disconnect: (id) => {
      connected.delete(id);
    },
    connectedToolkits: () => catalog.filter((c) => connected.has(c.id)).map((c) => c.id),
  };
}
