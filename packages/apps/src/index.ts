/** @vendoai/apps — the app artifact and engine (docs/contracts/06-apps.md).
 *
 * The sandbox seam is the execution-v2 shape (sandbox.ts); the v1 seam and
 * its compat bridge are deleted (execution-v2 Wave 1.5).
 * The package root otherwise exports exactly the 06 §1 public API plus the
 * block-plan's flagged additions (AppsConfig.pinBaselines), the ENG-288 M4
 * in-client trust-axis surface (06 §9): AppsRuntime.inClient, ship-diff
 * computation, appVersionHash, and the approval-record store access, and the
 * ENG-288 M5 drift→rebase surface (06 §8): AppsRuntime.pins and
 * detectPinDrift.
 * Everything else — the generation engine, interchange plumbing — is internal
 * and reachable only through AppsRuntime.
 */
export {
  createApps,
  type AppsConfig,
  type AppsRuntime,
  type BoxRequest,
  type BoxResponse,
  type EditFailure,
  type EditResult,
  type MachineEditResult,
  type OpenSurface,
  type PinRebaseResult,
  type SecretExposureState,
  type SetExposureResult,
  type VersionEntry,
} from "./runtime.js";
// execution-v2 Wave 3 — the in-box agent control-port client (the host side
// of the base box template's harness). BOX_CONTROL_PORT is the port the
// harness listens on, distinct from the app's $PORT.
export {
  BOX_CONTROL_PORT,
  pushBoxEnv,
  readBoxManifest,
  runBoxEdit,
  type BoxEditOptions,
  type BoxEditResult,
} from "./box-agent.js";
export {
  createSecretExposure,
  type SecretExposure,
  type SecretExposureGrant,
} from "./secret-exposure.js";
// execution-v2 Lane E — grant-style egress approval over the vendo.json
// declaration, enforced as the machine's network allowlist.
export {
  boxAllowlist,
  createEgressApprovals,
  normalizeEgressDomain,
  unapprovedEgress,
  type EgressApprovalRequest,
  type EgressApprovals,
} from "./egress-approval.js";
export type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "./sandbox.js";
// execution-v2 skin contract (Lane C): the manifest gate, the per-app box
// token, and the box env assembly Lane B consumes at provision.
export {
  parseVendoManifest,
  vendoManifestSchema,
  type VendoManifest,
  type VendoManifestSchedule,
} from "./manifest.js";
export {
  APP_TOKEN_COLLECTION,
  createAppTokens,
  type AppTokenIdentity,
  type AppTokens,
} from "./app-token.js";
export {
  buildEnv,
  type BuildEnvContext,
  type BuiltBoxEnv,
  type InferenceResolver,
} from "./box-env.js";
// execution-v2 Lane D — fn: resolution over the box door and the BYO
// schedule-execution engine (vendo.json schedules → authenticated tick).
export {
  createFnCaller,
  type FnCaller,
  type FnCallerConfig,
} from "./fn.js";
export {
  createScheduleEngine,
  SCHEDULE_STATE_COLLECTION,
  type AppScheduleState,
  type AppScheduleStatus,
  type ScheduleEngine,
  type ScheduleEngineConfig,
  type ScheduleFire,
  type ScheduleState,
  type ScheduleTickReport,
} from "./schedules.js";
// execution-v2 Lane B — the machine lifecycle over the canonical seam.
// (MachineSandboxAdapter has collapsed to a deprecated alias of SandboxAdapter
// now that destroy-by-ref lives on the seam itself.)
export {
  createMachineLifecycle,
  type BuildMachineAllowlist,
  type BuildMachineEnv,
  type LifecycleClock,
  type MachineEnvGrants,
  type MachineLifecycle,
  type MachineLifecycleConfig,
  type MachineSandboxAdapter,
} from "./machine-lifecycle.js";
export {
  shareSnapshotSchema,
  publishRecordSchema,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
export {
  detectPinDrift,
  inClientApprovalSchema,
  pinApprovalSchema,
  pinBaselineSchema,
  pinComponentName,
  pinShipRequestSchema,
  type InClientApproval,
  type PinApproval,
  type PinBaseline,
  type PinDrift,
  type PinShipRequest,
} from "./pins.js";
export { appVersionHash } from "./version-hash.js";
export {
  createInClientApprovals,
  type InClientApprovalAccess,
  type InClientVenueState,
  type InClientVerdict,
} from "./inclient.js";
export {
  computeShipDiff,
  type ShipDiff,
  type ShipDiffGenerated,
  type ShipDiffPin,
} from "./ship-diff.js";
export { unifiedDiff } from "./unified-diff.js";
