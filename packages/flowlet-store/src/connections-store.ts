/**
 * DrizzleConnectionsStore — durable implementation of the STRUCTURAL shape of
 * @flowlet/next's `ConnectionsStore` (packages/flowlet-next/src/connections.ts):
 * which toolkits are connected, i.e. what the agent ingests. Duck-typed
 * locally (not imported) to avoid a next -> store -> next dependency cycle.
 * Both the upstream interface and this durable port are fully async — every
 * operation here is a DB round-trip, and the upstream in-memory store matches
 * that shape (even though it never actually awaits) so the two are drop-in
 * compatible: `@flowlet/next`'s handler wires this in whenever durable
 * storage is configured, the in-memory one otherwise.
 *
 * Two additions beyond the upstream shape (webhook + integrations flow):
 *  - `setConnectedAccount` records the Composio connected-account id once the
 *    OAuth flow lands.
 *  - `findByConnectedAccount` is a CROSS-PRINCIPAL lookup (unlike every other
 *    method here, which is scoped to the store's own Principal) — webhook
 *    routing needs to answer "which principal owns this connected account?"
 *    before it has a scope to work with.
 */
import { and, eq } from "drizzle-orm";
import type { Principal } from "@flowlet/core";
import type { FlowletDb } from "./db.js";
import { connections } from "./schema.js";

/** Structural stand-in for @flowlet/next's `IntegrationCatalogEntry`. */
export interface IntegrationCatalogEntry {
  id: string;
  name: string;
}

export interface DurableConnectionsStore {
  list(): Promise<Array<IntegrationCatalogEntry & { connected: boolean }>>;
  connect(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  connectedToolkits(): Promise<string[]>;
  /** Record the Composio connected-account id once the OAuth flow lands. */
  setConnectedAccount(toolkit: string, connectedAccountId: string): Promise<void>;
  /** Webhook routing: which principal owns this connected account? */
  findByConnectedAccount(connectedAccountId: string): Promise<{ toolkit: string; principal: Principal } | undefined>;
}

const CONNECTED = "connected";
const DISCONNECTED = "disconnected";

export function createDrizzleConnectionsStore(
  handle: FlowletDb,
  scope: Principal,
  catalog: IntegrationCatalogEntry[],
  opts: { now?: () => string } = {},
): DurableConnectionsStore {
  const db = handle.db;
  const now = opts.now ?? (() => new Date().toISOString());
  const validIds = new Set(catalog.map((c) => c.id));

  async function connectedSet(): Promise<Set<string>> {
    const rows = await db
      .select({ toolkit: connections.toolkit })
      .from(connections)
      .where(
        and(
          eq(connections.tenantId, scope.tenantId),
          eq(connections.subject, scope.subject),
          eq(connections.status, CONNECTED),
        ),
      );
    return new Set(rows.map((r) => r.toolkit));
  }

  return {
    async list() {
      const connected = await connectedSet();
      return catalog.map((c) => ({ ...c, connected: connected.has(c.id) }));
    },

    async connect(id: string): Promise<void> {
      if (!validIds.has(id)) return;
      await db
        .insert(connections)
        .values({
          toolkit: id,
          tenantId: scope.tenantId,
          subject: scope.subject,
          connectedAccountId: null,
          status: CONNECTED,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [connections.tenantId, connections.subject, connections.toolkit],
          set: { status: CONNECTED },
        });
    },

    async disconnect(id: string): Promise<void> {
      await db
        .update(connections)
        .set({ status: DISCONNECTED })
        .where(
          and(
            eq(connections.tenantId, scope.tenantId),
            eq(connections.subject, scope.subject),
            eq(connections.toolkit, id),
          ),
        );
    },

    async connectedToolkits(): Promise<string[]> {
      const connected = await connectedSet();
      return catalog.filter((c) => connected.has(c.id)).map((c) => c.id);
    },

    async setConnectedAccount(toolkit: string, connectedAccountId: string): Promise<void> {
      if (!validIds.has(toolkit)) return;
      await db
        .insert(connections)
        .values({
          toolkit,
          tenantId: scope.tenantId,
          subject: scope.subject,
          connectedAccountId,
          status: CONNECTED,
          createdAt: now(),
        })
        .onConflictDoUpdate({
          target: [connections.tenantId, connections.subject, connections.toolkit],
          set: { connectedAccountId, status: CONNECTED },
        });
    },

    async findByConnectedAccount(
      connectedAccountId: string,
    ): Promise<{ toolkit: string; principal: Principal } | undefined> {
      const rows = await db
        .select()
        .from(connections)
        .where(eq(connections.connectedAccountId, connectedAccountId));
      const row = rows[0];
      if (!row) return undefined;
      return { toolkit: row.toolkit, principal: { tenantId: row.tenantId, subject: row.subject } };
    },
  };
}
