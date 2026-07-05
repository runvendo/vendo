/**
 * Boot-time durable-storage resolution for `createVendoHandler`.
 *
 * DURABLE BY DEFAULT: with no `storage` option at all, this still builds a
 * database handle — PGlite under `.vendo/data` (or `DATABASE_URL` /
 * `VENDO_DATA_DIR`) — because zero-config durability is the whole point of
 * the OSS install story. `storage: false` is the only path back to an
 * in-memory, non-durable engine store.
 *
 * TEST-ENV SAFETY NET: assembling the handler dozens of times in a unit-test
 * process must not spray `.vendo/data` directories across the repo. When
 * `NODE_ENV === "test"` and the caller passed NO `storage` option at all,
 * this silently behaves like `storage: false` — no warning, since that's the
 * normal, expected shape for a test run. An explicit `storage` value
 * (including `false`) always wins over this default, in every environment.
 */
import { createVendoDatabase, migrateVendoDatabase, type VendoDb } from "@vendoai/store";
import type { VendoHandlerOptions } from "./options.js";

export async function resolveStorage(
  options: VendoHandlerOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<VendoDb | null> {
  if (options.storage === false) return null;
  if (options.storage === undefined && env["NODE_ENV"] === "test") return null;

  const handle = await createVendoDatabase({
    connectionString: options.storage?.connectionString,
    pglite: options.storage?.pglite,
  });
  if (options.storage?.autoMigrate !== false) {
    await migrateVendoDatabase(handle);
  }
  return handle;
}
