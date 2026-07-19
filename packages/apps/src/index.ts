/** @vendoai/apps — the app artifact and engine (docs/contracts/06-apps.md).
 *
 * The sandbox seam is the execution-v2 shape (sandbox.ts); the archived v1
 * seam survives only as the deprecated V1Sandbox* transition surface below,
 * deleted with the last v1 path (see sandbox-v1-compat.ts header).
 * The package root otherwise exports exactly the 06 §1 public API plus the
 * block-plan's flagged additions (AppsConfig.proxyUrl/pinBaselines/
 * egressTransport, AppsRuntime.proxy,
 * substituteSecretHandles/hostAllowed), the ENG-259 SSRF egress guard
 * (checkEgressUrl, isBlockedAddress) exposed for reuse, the ENG-288 M4
 * in-client trust-axis surface (06 §9): AppsRuntime.inClient, ship-diff
 * computation, appVersionHash, and the approval-record store access, and the
 * ENG-288 M5 drift→rebase surface (06 §8): AppsRuntime.pins and
 * detectPinDrift.
 * Everything else — machine sessions, run tokens, the generation engine,
 * interchange plumbing — is internal and reachable only through AppsRuntime.
 */
export {
  createApps,
  type AppsConfig,
  type AppsProxy,
  type AppsRuntime,
  type BoxRequest,
  type BoxResponse,
  type EditFailure,
  type EditResult,
  type OpenSurface,
  type PinRebaseResult,
  type SecretExposureState,
  type SetExposureResult,
  type VersionEntry,
} from "./runtime.js";
export {
  createSecretExposure,
  type SecretExposure,
  type SecretExposureGrant,
} from "./secret-exposure.js";
export type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
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
export {
  toV1SandboxAdapter,
  type V1SandboxAdapter,
  type V1SandboxCreateSpec,
  type V1SandboxMachine,
} from "./sandbox-v1-compat.js";
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
export {
  hostAllowed,
  substituteSecretHandles,
  type SandboxEgressRequest,
  type SecretHandleMap,
} from "./egress.js";
export {
  checkEgressUrl,
  isBlockedAddress,
  nodeIpResolver,
  type EgressUrlCheck,
  type IpResolver,
} from "./ssrf.js";
