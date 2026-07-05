/**
 * The connections store: which toolkits are connected, i.e. what the agent
 * ingests. Kept free of Composio imports so options/typing can depend on it
 * without pulling server modules.
 */
import type { Principal } from "@flowlet/core";
import type { IntegrationCatalogEntry } from "./options";
import { WORLD_SCOPE } from "./guard";

export interface ConnectionsStore {
  list(): Promise<Array<IntegrationCatalogEntry & { connected: boolean }>>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  connectedToolkits(): Promise<string[]>;
  /**
   * Record the Composio connected-account id once the OAuth flow lands.
   * Same shape as @flowlet/store's `DurableConnectionsStore` — the durable
   * port (createDrizzleConnectionsStore) is a drop-in for this store.
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
 *  agent ingests. Everything starts DISCONNECTED on boot. Every method is
 *  async (even though nothing here actually awaits) so this is a drop-in for
 *  the durable, DB-backed `createDrizzleConnectionsStore` port. */
export function createConnectionsStore(catalog: IntegrationCatalogEntry[]): ConnectionsStore {
  const validIds = new Set(catalog.map((c) => c.id));
  const connected = new Set<string>();
  // v1 is single-tenant, so every captured account belongs to WORLD_SCOPE —
  // this map exists to answer "which toolkit" and to make the lookup key the
  // Composio connectedAccountId, not to disambiguate principals.
  const byAccount = new Map<string, { toolkit: string; principal: Principal }>();
  return {
    async list() {
      return catalog.map((c) => ({ ...c, connected: connected.has(c.id) }));
    },
    async connect(id) {
      if (validIds.has(id)) connected.add(id);
    },
    async disconnect(id) {
      connected.delete(id);
      // Revoke webhook routing too: a redelivered/live Composio webhook for
      // this toolkit's connected account must not resolve a principal once
      // the user disconnected it — matches the durable port's
      // status-filtered findByConnectedAccount (connections-store.ts).
      for (const [accountId, entry] of byAccount) {
        if (entry.toolkit === id) byAccount.delete(accountId);
      }
    },
    async connectedToolkits() {
      return catalog.filter((c) => connected.has(c.id)).map((c) => c.id);
    },
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
