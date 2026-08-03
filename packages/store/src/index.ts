/** @vendoai/store — persistence under everything (docs/contracts/02-store.md).
 *  Postgres-only consumers: import from `@vendoai/store/postgres` instead to
 *  keep the PGlite wasm engine out of the bundle graph. */
export { createStore } from "./create-store.js";
export { type VendoStore } from "./store.js";
// The reserved-collection map (02-store §2): exported so remote StoreAdapters
// (the umbrella's hostedStore) can mirror this engine's per-collection
// capability shape — claim on non-routed collections, atomic on generic
// collections and vendo_threads — without re-deriving the routing table.
export {
  DEDICATED_RECORD_COLLECTIONS,
  RESERVED_COLLECTIONS,
  type ReservedCollection,
} from "./routing.js";
export { eraseStore, type EraseReport, type EraseTable } from "./erase.js";
export {
  claimEphemeralSubject,
  listStaleEphemeralSubjects,
  registerEphemeralSubject,
  sweepEphemeralSubjects,
} from "./sessions.js";
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
  adoptEphemeralSubject,
  type SubjectMergeReport,
} from "./helpers/subjects.js";
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
export { storeFiles, FILES_STORE_MAX_BYTES } from "./files-store.js";
export { s3, type S3FilesOptions } from "./files-s3.js";
export { workspaceBash, type BashRun, type WorkspaceBashSetup } from "./workspace-bash.js";
export { harnessStateStore } from "./harness-state.js";
