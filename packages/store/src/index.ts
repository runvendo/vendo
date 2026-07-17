/** @vendoai/store — persistence under everything (docs/contracts/02-store.md). */
export { createStore, type VendoStore } from "./store.js";
export { eraseStore, type EraseReport, type EraseTable } from "./erase.js";
export {
  registerEphemeralSubject,
  beginEphemeralRequest,
  endEphemeralRequest,
  evictEphemeralSubject,
  sweepEphemeralSubjects,
  setSessionClock,
  setSessionCap,
  ephemeralOverlaySizes,
  EPHEMERAL_SUBJECT_CAP,
  type EphemeralSession,
  type AppEphemerality,
} from "./ephemeral.js";
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
