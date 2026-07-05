/**
 * `meta` helpers — the tiny operational KV over the `flowlet.meta` table
 * (scheduler heartbeat, future flags). NOT for domain data; see the table
 * doc in schema.ts.
 */
import { eq } from "drizzle-orm";
import type { FlowletDb } from "./db.js";
import { meta } from "./schema.js";

/** Read one meta value; `undefined` on a miss. */
export async function getMeta(handle: FlowletDb, key: string): Promise<unknown> {
  const rows = await handle.db.select().from(meta).where(eq(meta.key, key));
  return rows[0]?.value;
}

/** Upsert one meta value (last write wins). */
export async function setMeta(handle: FlowletDb, key: string, value: unknown): Promise<void> {
  const updatedAt = new Date().toISOString();
  await handle.db
    .insert(meta)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: meta.key, set: { value, updatedAt } });
}
