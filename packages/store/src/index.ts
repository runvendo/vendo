/** @vendoai/store — persistence under everything (docs/contracts/02-store.md).
 *  Postgres-only consumers: import from `@vendoai/store/postgres` instead to
 *  keep the PGlite wasm engine out of the bundle graph. */
export { createStore } from "./create-store.js";
export { maybeDbFor, type VendoStore } from "./store.js";
// The Db seam: a host that already holds a connection (a pooler, an open
// transaction) builds the store over it instead of handing us a url.
export { createStoreForDb } from "./store.js";
export type { Db, Query } from "./db-postgres.js";
// Composed state, read off the engine handle `maybeDbFor` returns: the data dir
// this store writes to when a redeploy wipes it. The deployment that composed
// the store is what tells its operator (createVendo's boot block).
export type { EphemeralDataDir } from "./db-postgres.js";
// The StoreOps local backend (02-store): the 44-op named-operation contract
// served off this store's own Postgres, transactions at verb boundaries.
export { createStoreOps } from "./ops.js";
// The `Idempotency-Key` replay ledger (01 §12). `createStore()` already hands
// one out on the store handle; this is the door for a host assembling its own
// mount over a Db it owns — the ledger MUST be the one that shares a database
// with the mutations it gates.
export { createIdempotencyLedger } from "./idempotency.js";
// The one composer of appData names and the owner stamp: everything that
// serves the family (the local backend here, the surfaces above it) spells
// `app:<appId>:<collection>` and `<owner>/<key>` through these and nowhere else.
export {
  appDataFiles,
  appDataRows,
  appDataCollection,
  appDataNamespace,
  appDataFileKey,
  APP_DATA_OWNER_REF,
} from "./app-data-rows.js";
// The one-shot migration for appData that predates the owner stamp: without it
// every such row goes invisible the moment a door flips onto the family.
export { backfillAppDataStamps, type AppDataBackfillReport } from "./backfill-app-data.js";
export { backfillAppRefKey, type AppRefKeyBackfillReport } from "./backfill-app-data.js";
// The reserved-collection map (02-store §2): exported so remote StoreAdapters
// (`hostedStore` below) can mirror this engine's per-collection
// capability shape — claim on non-routed collections, atomic on generic
// collections and vendo_threads — without re-deriving the routing table.
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
// The workspace (build contract §3): the agent's filesystem as a façade over
// the two vendo_workspace_* tables, plus the blob seam under it.
export {
  workspaceStore,
  WORKSPACE_HISTORY_LIMIT,
  WORKSPACE_INLINE_MAX_BYTES,
  HOST_MOUNT,
  USER_MOUNT,
  type AppMount,
  type HostProjection,
  type WorkspaceFileMeta,
  type WorkspaceHistoryEntry,
} from "./workspace.js";
// `turn.load`'s index page in the units `workspaceStore.open` takes, so a
// caller that batched the read hands back rows it never had to reshape.
export { workspaceIndexPage } from "./workspace-ops-rows.js";
// The envelope fanned back out over the ops it bundles: exported so a third
// implementation (the console's native engine) serves `turn.load` from this
// one definition instead of mirroring it.
export { turnLoadOverOps } from "./helpers/turn.js";
export { storeFiles, FILES_STORE_MAX_BYTES } from "./files-store.js";
export { harnessStateKey, harnessStateRow, harnessStateStore } from "./harness-state.js";
// The Cloud store: the same StoreAdapter and the same ops, over the console
// wire instead of a local Postgres. It lives HERE so every helper above can be
// served by it without the caller reaching for the umbrella.
export { hostedStore, hostedStoreOps, type HostedStore, type HostedStoreOptions } from "./hosted-store.js";
