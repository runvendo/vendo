/** @vendoai/apps — the app artifact and engine (docs/contracts/06-apps.md).
 *
 * The package root exports exactly the 06 §1 public API plus the block-plan's
 * flagged additions (AppsConfig.proxyUrl/pinBaselines/egressTransport,
 * AppsRuntime.proxy, SandboxMachine.url?, create-spec egress?,
 * substituteSecretHandles/hostAllowed), the ENG-259 SSRF egress guard
 * (checkEgressUrl, isBlockedAddress) exposed for reuse, and the ENG-288 M4
 * in-client trust-axis surface (06 §9): AppsRuntime.inClient, ship-diff
 * computation, appVersionHash, and the approval-record store access.
 * Everything else — machine sessions, run tokens, the generation engine,
 * interchange plumbing — is internal and reachable only through AppsRuntime.
 */
export {
  createApps,
  type AppsConfig,
  type AppsProxy,
  type AppsRuntime,
  type EditFailure,
  type EditResult,
  type OpenSurface,
  type VersionEntry,
} from "./runtime.js";
export type { SandboxAdapter, SandboxMachine } from "./sandbox.js";
export {
  shareSnapshotSchema,
  publishRecordSchema,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
export {
  inClientApprovalSchema,
  pinApprovalSchema,
  pinBaselineSchema,
  pinComponentName,
  pinShipRequestSchema,
  type InClientApproval,
  type PinApproval,
  type PinBaseline,
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
