/**
 * DrizzleSavedFlowletStore — durable port of the core `SavedFlowletStore`
 * seam (packages/flowlet-core/src/seams/store.ts). Behavioral spec:
 * InMemorySavedFlowletStore (packages/flowlet-runtime/src/embedded/in-memory-store.ts).
 *
 * The whole `SavedFlowlet` record (uiTree, query, originatingPrompt, etc.)
 * lives verbatim in the `record` jsonb column; `updatedAt` is denormalized
 * onto its own column purely so `list()` can order by it without unpacking
 * jsonb per row.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Principal, SavedFlowlet, SavedFlowletStore } from "@flowlet/core";
import type { FlowletDb } from "./db.js";
import { savedFlowlets } from "./schema.js";

export function createDrizzleSavedFlowletStore(
  handle: FlowletDb,
  opts: { now?: () => string } = {},
): SavedFlowletStore {
  const db = handle.db;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async save(
      scope: Principal,
      flowlet: Omit<SavedFlowlet, "id" | "createdAt" | "updatedAt">,
    ): Promise<SavedFlowlet> {
      const id = randomUUID();
      const createdAt = now();
      const record: SavedFlowlet = { ...flowlet, id, createdAt, updatedAt: createdAt };
      await db.insert(savedFlowlets).values({
        id,
        tenantId: scope.tenantId,
        subject: scope.subject,
        record,
        updatedAt: createdAt,
      });
      return record;
    },

    async get(scope: Principal, id: string): Promise<SavedFlowlet | undefined> {
      const rows = await db
        .select()
        .from(savedFlowlets)
        .where(
          and(
            eq(savedFlowlets.tenantId, scope.tenantId),
            eq(savedFlowlets.subject, scope.subject),
            eq(savedFlowlets.id, id),
          ),
        );
      return rows[0] ? (rows[0].record as SavedFlowlet) : undefined;
    },

    async list(scope: Principal): Promise<SavedFlowlet[]> {
      const rows = await db
        .select()
        .from(savedFlowlets)
        .where(and(eq(savedFlowlets.tenantId, scope.tenantId), eq(savedFlowlets.subject, scope.subject)))
        .orderBy(desc(savedFlowlets.updatedAt));
      return rows.map((row) => row.record as SavedFlowlet);
    },

    async delete(scope: Principal, id: string): Promise<void> {
      await db
        .delete(savedFlowlets)
        .where(
          and(
            eq(savedFlowlets.tenantId, scope.tenantId),
            eq(savedFlowlets.subject, scope.subject),
            eq(savedFlowlets.id, id),
          ),
        );
    },
  };
}
