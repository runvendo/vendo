/** @vendoai/apps — the app artifact and engine (docs/contracts/06-apps.md).
 *
 * The package root exports exactly the 06 §1 public API plus the block-plan's
 * flagged additions (AppsConfig.proxyUrl/pinBaselines, AppsRuntime.proxy,
 * SandboxMachine.url?, create-spec egress?, substituteSecretHandles).
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
  pinShipRequestSchema,
  type InClientApproval,
  type PinApproval,
  type PinBaseline,
  type PinShipRequest,
} from "./pins.js";
export {
  substituteSecretHandles,
  type SandboxEgressRequest,
  type SecretHandleMap,
} from "./egress.js";
