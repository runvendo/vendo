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
  buildFailureReason,
  createApps,
  type AppsConfig,
  type AppsRuntime,
  type BoxRequest,
  type BoxResponse,
  type EditFailure,
  type EditResult,
  type MachineEditResult,
  type OpenSurface,
  type PinForkInput,
  type PinForkResult,
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
  type CloudAppsClient,
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
  type ReviewStanding,
} from "./inclient.js";
// Remix final shape (2026-08-02) — the review-kind lifecycle vocabulary:
// the queue entry the console seam lists and the rejection record the note
// surfaces from (AppsRuntime.review is the behavior surface).
export {
  remixRejectionSchema,
  type RemixRejection,
  type ReviewQueueEntry,
} from "./review.js";
export {
  type ShipDiff,
  type ShipDiffGenerated,
  type ShipDiffPin,
} from "./ship-diff.js";
// The bench host surface (tools/genui-bench): the demo-bank catalog/tool/shape
// loaders the live harnesses already share, exported because the exports map
// closes deep imports. Data-only helpers — no engine behavior rides on them.
// HostToolInfo is the tool slice those loaders (and GenerationDependencies)
// speak.
export type { HostToolInfo } from "./generation/engine.js";
export {
  demoBankToolShapes,
  loadDemoBankCatalog,
  loadDemoBankTools,
} from "./bench/demo-bank-surface.js";
// The checking layer's contract: the shape a host writes an AppsConfig.checks
// entry in, and the finding shape every check reports (checking/types.ts).
export type {
  Check,
  CheckInput,
  CheckingLayer,
  Finding,
} from "./checking/types.js";
// The plan→layout function, exported for the same reason as the bench loaders
// above (the exports map closes deep imports): it is a pure, deterministic
// function of the public AppPlan, so demo/harness surfaces can render a plan's
// skeleton without booting the engine.
export { skeletonFromPlan, type Skeleton } from "./generation/skeleton.js";
// The model-capability rule (model-params.ts): which Claude ids still accept
// sampling params, and the output cap for ids a sampling-era provider registry
// does not know. Exported for the umbrella's model ladder — its lazy wrapper
// reports a family id ("vendo-env"), so the resolved rung's REAL id must be
// re-checked at call time (#692). Data-only rule — no engine behavior rides
// on the export.
export {
  acceptsSamplingParams,
  UNKNOWN_MODEL_MAX_OUTPUT_TOKENS,
} from "./model-params.js";
export {
  UNSTORED_APP_ID,
  type GeneratedAppDocument,
  type GenerationDependencies,
} from "./generation/engine.js";
// The apps PACK's raw materials: the tools it declares through `Pack.tools` and
// the skill it teaches the pattern with. The pack itself is assembled in the
// umbrella (`vendo/src/packs/apps.ts`), which is the only layer that has both
// the runtime and `definePack` in scope.
export { agentToolDescriptors } from "./agent-tools.js";
export { buildingAppsSkill } from "./skills/building-apps.js";
// The generation seam for the genui-bench vendo lane: the SAME conductor
// createApps() rides, driven directly against a host fixture with no store
// behind it. Additive export — generation behavior is identical.
export {
  conductCreate,
  conductEdit,
  type ConductedApp,
  type ConductedResult,
  type ConductorOptions,
} from "./generation/conductor.js";
