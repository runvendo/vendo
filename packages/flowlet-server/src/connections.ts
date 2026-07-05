/**
 * The connections store: which toolkits are connected, i.e. what the agent
 * ingests. Kept free of Composio imports so options/typing can depend on it
 * without pulling server modules.
 */
import type { Principal } from "@flowlet/core";
import type { IntegrationCatalogEntry } from "./options";
import { WORLD_SCOPE } from "./guard";

export interface ConnectionsStore {
  list(): Array<IntegrationCatalogEntry & { connected: boolean }>;
  connect(id: string): void;
  disconnect(id: string): void;
  connectedToolkits(): string[];
  /**
   * Record the Composio connected-account id once the OAuth flow lands
   * (Task 9 shape — @flowlet/store's `DurableConnectionsStore` has the same
   * two methods, so a future durable wiring needs no interface surprises).
   * Async even on this in-memory impl since the durable port necessarily is.
   */
  setConnectedAccount(toolkit: string, connectedAccountId: string): Promise<void>;
  /**
   * Webhook routing: which principal owns this connected account? Answers
   * BEFORE a request-scoped identity exists (unlike every other method here,
   * which is implicitly scoped to the single embedded tenant).
   */
  findByConnectedAccount(
    connectedAccountId: string,
  ): Promise<{ toolkit: string; principal: Principal } | undefined>;
}

/** In-memory connected-toolkit set — the single source of truth for what the
 *  agent ingests. Everything starts DISCONNECTED on boot. */
export function createConnectionsStore(catalog: IntegrationCatalogEntry[]): ConnectionsStore {
  const validIds = new Set(catalog.map((c) => c.id));
  const connected = new Set<string>();
  // v1 is single-tenant, so every captured account belongs to WORLD_SCOPE —
  // this map exists to answer "which toolkit" and to make the lookup key the
  // Composio connectedAccountId, not to disambiguate principals.
  const byAccount = new Map<string, { toolkit: string; principal: Principal }>();
  return {
    list: () => catalog.map((c) => ({ ...c, connected: connected.has(c.id) })),
    connect: (id) => {
      if (validIds.has(id)) connected.add(id);
    },
    disconnect: (id) => {
      connected.delete(id);
    },
    connectedToolkits: () => catalog.filter((c) => connected.has(c.id)).map((c) => c.id),
    async setConnectedAccount(toolkit, connectedAccountId) {
      if (!validIds.has(toolkit)) return;
      connected.add(toolkit);
      byAccount.set(connectedAccountId, { toolkit, principal: WORLD_SCOPE });
    },
    async findByConnectedAccount(connectedAccountId) {
      return byAccount.get(connectedAccountId);
    },
  };
}
