/**
 * DrizzleSavedVendoStore — durable port of the core `SavedVendoStore`
 * seam (packages/vendo-core/src/seams/store.ts). Behavioral spec:
 * InMemorySavedVendoStore (packages/vendo-runtime/src/embedded/in-memory-store.ts).
 *
 * The whole `SavedVendo` record (uiTree, query, originatingPrompt, etc.)
 * lives verbatim in the `record` jsonb column; `updatedAt` is denormalized
 * onto its own column purely so `list()` can order by it without unpacking
 * jsonb per row.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Principal, SavedVendo, SavedVendoStore } from "@vendoai/core";
import type { VendoDb } from "./db.js";
import { savedVendos } from "./schema.js";

export function createDrizzleSavedVendoStore(
  handle: VendoDb,
  opts: { now?: () => string } = {},
): SavedVendoStore {
  const db = handle.db;
  const now = opts.now ?? (() => new Date().toISOString());

  return {
    async save(
      scope: Principal,
      vendo: Omit<SavedVendo, "id" | "createdAt" | "updatedAt">,
    ): Promise<SavedVendo> {
      const id = randomUUID();
      const createdAt = now();
      const record: SavedVendo = { ...vendo, id, createdAt, updatedAt: createdAt };
      await db.insert(savedVendos).values({
        id,
        tenantId: scope.tenantId,
        subject: scope.subject,
        record,
        updatedAt: createdAt,
      });
      return record;
    },

    async get(scope: Principal, id: string): Promise<SavedVendo | undefined> {
      const rows = await db
        .select()
        .from(savedVendos)
        .where(
          and(
            eq(savedVendos.tenantId, scope.tenantId),
            eq(savedVendos.subject, scope.subject),
            eq(savedVendos.id, id),
          ),
        );
      return rows[0] ? (rows[0].record as SavedVendo) : undefined;
    },

    async list(scope: Principal): Promise<SavedVendo[]> {
      const rows = await db
        .select()
        .from(savedVendos)
        .where(and(eq(savedVendos.tenantId, scope.tenantId), eq(savedVendos.subject, scope.subject)))
        .orderBy(desc(savedVendos.updatedAt));
      return rows.map((row) => row.record as SavedVendo);
    },

    async delete(scope: Principal, id: string): Promise<void> {
      await db
        .delete(savedVendos)
        .where(
          and(
            eq(savedVendos.tenantId, scope.tenantId),
            eq(savedVendos.subject, scope.subject),
            eq(savedVendos.id, id),
          ),
        );
    },
  };
}
