/** @vendoai/store/postgres — the same store on a real Postgres, with the
 *  PGlite dev-mode default cut out of the module graph entirely. The main
 *  entry's graph carries the wasm Postgres (a multi-megabyte upload that a
 *  serverless runtime can't even execute — a Cloudflare Worker importing it
 *  silently crossed the bundle size ceiling in the field), so consumers that
 *  only ever connect to a real Postgres import this entry instead. Identical
 *  schema, records, blobs, secrets, and helpers; only the engine picker
 *  differs. Purity is enforced by scripts/portability-gate.mjs and
 *  src/postgres-entry.test.ts. */
import { VendoError } from "@vendoai/core";
import { createPostgresDb, type StoreConfig } from "./db-postgres.js";
import { createStoreForDb, type VendoStore } from "./store.js";

export type { VendoStore };

/** StoreConfig for the Postgres-only entry: `url` is mandatory and the PGlite
 *  `dataDir` does not exist here. */
export interface PostgresStoreConfig extends Pick<StoreConfig, "encryption" | "allowUnencryptedSecrets"> {
  url: string;
}

/** 02-store §1 — Postgres-only `createStore`. */
export function createStore(config: PostgresStoreConfig): VendoStore {
  if (!config.url) {
    throw new VendoError(
      "validation",
      "@vendoai/store/postgres needs a Postgres connection string — pass { url }. "
        + 'For the zero-config PGlite dev default, import createStore from "@vendoai/store" instead.',
    );
  }
  return createStoreForDb(createPostgresDb(config.url), config);
}

// The rest of the store surface is engine-agnostic — the same modules the
// main entry exports (keep this list in lockstep with index.ts).
export { createStoreOps } from "./ops.js";
export { maybeDbFor } from "./store.js";
export { createStoreForDb } from "./store.js";
export type { Db, Query } from "./db-postgres.js";
export {
  appDataFiles,
  appDataRows,
  appDataCollection,
  appDataNamespace,
  appDataFileKey,
  APP_DATA_OWNER_REF,
} from "./app-data-rows.js";
export { backfillAppDataStamps, type AppDataBackfillReport } from "./backfill-app-data.js";
export { backfillAppRefKey, type AppRefKeyBackfillReport } from "./backfill-app-data.js";
export {
  DEDICATED_RECORD_COLLECTIONS,
  RESERVED_COLLECTIONS,
  type ReservedCollection,
} from "./routing.js";
export { eraseStore, type EraseReport, type EraseTable } from "./erase.js";
export { envSecrets, secretStore, storeSecrets } from "./secrets.js";
export { appStore, type AppRow } from "./helpers/apps.js";
// Build contract §9.3 — `can()`, the one permission function every door reaches.
export {
  appAccess,
  parseGrantPrincipal,
  type AccessLevel,
  type AppAccess,
  type AppGrantRecord,
  type CanThing,
  type GrantPrincipal,
} from "./helpers/app-access.js";
export { threadStore, type AskUserAnswer, type ThreadRow } from "./helpers/threads.js";
export { threadMessageStore, type ThreadMessageLike } from "./helpers/thread-messages.js";
export { grantStore } from "./helpers/grants.js";
export { auditStore, type AuditQuery } from "./helpers/audit.js";
export { runStore, type RunRow } from "./helpers/runs.js";
export {
  workspaceStore,
  WORKSPACE_HISTORY_LIMIT,
  WORKSPACE_INLINE_MAX_BYTES,
  HOST_MOUNT,
  USER_MOUNT,
  type HostProjection,
  type WorkspaceFileMeta,
  type WorkspaceHistoryEntry,
} from "./workspace.js";
export { storeFiles, FILES_STORE_MAX_BYTES } from "./files-store.js";
export { harnessStateStore } from "./harness-state.js";
