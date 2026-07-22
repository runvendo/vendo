/** Web-standard-runtime build of the store engines, selected by the package's
 *  `worker`/`workerd`/`edge-light`/`browser` conditions on `#store/db`. The
 *  local engines are Node by nature (PGlite on the filesystem, pg over TCP),
 *  so edge deployments must fill the store seam explicitly — hostedStore via
 *  VENDO_API_KEY, or a custom adapter. Keep this module free of node builtins;
 *  the portability gate bundles it. */
import { VendoError } from "@vendoai/core";

import type { Db, StoreConfig } from "./db.js";

export type { Db, StoreConfig };

const EDGE_MESSAGE =
  "the local store engines (PGlite on disk, Postgres over TCP) need Node; on this runtime pass `store:` to "
  + "createVendo explicitly — hostedStore via VENDO_API_KEY, or a custom adapter";

export function createDb(_config: StoreConfig = {}): Db {
  throw new VendoError("validation", EDGE_MESSAGE);
}

export function withSchemaLock<T>(_db: Db, _work: (query: unknown) => Promise<T>): Promise<T> {
  return Promise.reject(new VendoError("validation", EDGE_MESSAGE));
}
