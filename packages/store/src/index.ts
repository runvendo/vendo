/** @vendoai/store — persistence under everything (docs/contracts/02-store.md). */
export { createStore, type VendoStore } from "./store.js";
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
export { stateStore } from "./helpers/state.js";
export { threadStore, type ThreadRow } from "./helpers/threads.js";
export { grantStore } from "./helpers/grants.js";
export { approvalStore, type ApprovalRow } from "./helpers/approvals.js";
export { auditStore, type AuditQuery } from "./helpers/audit.js";
export { runStore, type RunRow } from "./helpers/runs.js";
export {
  adoptEphemeralSubject,
  type SubjectMergeReport,
} from "./helpers/subjects.js";
