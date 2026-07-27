import { createDb, type StoreConfig } from "#store/db";
import { createStoreForDb, type VendoStore } from "./store.js";

/** 02-store §1 — the main-entry `createStore`: a Postgres `url` picks the pg
 *  engine, otherwise the PGlite zero-config dev default. Consumers that only
 *  ever run on real Postgres should import from `@vendoai/store/postgres`
 *  instead, which keeps the PGlite wasm out of their bundle graph entirely. */
export function createStore(config: StoreConfig = {}): VendoStore {
  return createStoreForDb(createDb(config), config);
}
