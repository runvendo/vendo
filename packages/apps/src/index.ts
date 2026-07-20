/** @vendoai/apps — the app artifact and engine (docs/contracts/06-apps.md).
 *
 * The sandbox seam is the execution-v2 shape (sandbox.ts); the v1 seam and
 * its compat bridge are deleted (execution-v2 Wave 1.5).
 * The package root otherwise exports exactly the 06 §1 public API plus the
 * block-plan's flagged additions (AppsConfig.pinBaselines), the ENG-288 M4
 * in-client trust-axis surface (06 §9): AppsRuntime.inClient and
 * appVersionHash, and the ENG-288 M5 drift→rebase surface (06 §8):
 * AppsRuntime.pins and detectPinDrift.
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
  createAppTokens,
  type AppTokens,
} from "./app-token.js";
export {
  buildEnv,
  type BuildEnvContext,
  type BuiltBoxEnv,
  type InferenceResolver,
} from "./box-env.js";
// execution-v2 Lane D — the BYO schedule engine's state collection (the wire
// tests pin its name).
export { SCHEDULE_STATE_COLLECTION } from "./schedules.js";
export {
  shareSnapshotSchema,
  publishRecordSchema,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
export {
  detectPinDrift,
  inClientApprovalSchema,
  pinBaselineSchema,
  pinComponentName,
  type InClientApproval,
  type PinBaseline,
  type PinDrift,
} from "./pins.js";
export { appVersionHash } from "./version-hash.js";
export {
  type InClientVenueState,
  type InClientVerdict,
} from "./inclient.js";
export {
  type ShipDiff,
  type ShipDiffGenerated,
  type ShipDiffPin,
} from "./ship-diff.js";
