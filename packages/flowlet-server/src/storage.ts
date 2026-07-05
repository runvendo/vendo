/**
 * Boot-time durable-storage resolution for `createFlowletHandler`.
 *
 * DURABLE BY DEFAULT: with no `storage` option at all, this still builds a
 * database handle — PGlite under `.flowlet/data` (or `DATABASE_URL` /
 * `FLOWLET_DATA_DIR`) — because zero-config durability is the whole point of
 * the OSS install story. `storage: false` is the only path back to an
 * in-memory, non-durable engine store.
 *
 * TEST-ENV SAFETY NET: assembling the handler dozens of times in a unit-test
 * process must not spray `.flowlet/data` directories across the repo. When
 * `NODE_ENV === "test"` and the caller passed NO `storage` option at all,
 * this silently behaves like `storage: false` — no warning, since that's the
 * normal, expected shape for a test run. An explicit `storage` value
 * (including `false`) always wins over this default, in every environment.
 */
import { createFlowletDatabase, migrateFlowletDatabase, type FlowletDb } from "@flowlet/store";
import type { FlowletHandlerOptions } from "./options";

export async function resolveStorage(
  options: FlowletHandlerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<FlowletDb | null> {
  if (options.storage === false) return null;
  if (options.storage === undefined && env["NODE_ENV"] === "test") return null;

  const handle = await createFlowletDatabase({
    connectionString: options.storage?.connectionString,
    pglite: options.storage?.pglite,
  });
  if (options.storage?.autoMigrate !== false) {
    await migrateFlowletDatabase(handle);
  }
  return handle;
}
