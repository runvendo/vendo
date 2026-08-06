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
  type AuthoredAppResult,
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
// A machine app's vendo.json schedules are doc triggers: the shapes
// `AppsRuntime.machine`'s syncManifest and report answer with. The converter's
// own constants stay internal to it — nothing outside needs them yet, and an
// export is additive the day something does.
export type {
  AppMachineStatus,
  ManifestTriggerResult,
  ManifestTriggerSync,
} from "./manifest-triggers.js";
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
// HostToolInfo is the tool slice GenerationDependencies (and external
// harnesses) speak.
export type { HostToolInfo } from "./generation/engine.js";
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
// The automation planner, exported for the same reason as the skeleton above: it
// is one model call over public inputs, so a harness can author (and prove the
// refusal of) an automation plan without booting the generation pipeline.
export { planAutomation, type AutomationPlan, type AutomationPlanInput } from "./automation-plan.js";
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
// What app generation mounts itself with: the tools it declares and the skill
// it teaches the pattern with. The umbrella composes them (`server.ts`), which
// is the only layer holding both these values and the live runtime they act
// through.
export { agentToolDescriptors } from "./agent-tools.js";
export { buildingAppsSkill } from "./skills/building-apps.js";
// The host's own theme and design rules, as the writers read them. Public
// because both briefs that carry them are assembled outside this package — the
// screen agent's in `@vendoai/harnesses`, the builder's in composition — and a
// second rendering of the same two config keys is how they start to disagree.
export { hostDesignBrief } from "./generation/contracts/sections.js";
// `conductCreate` / `conductEdit` and their result types were public here for
// "external bench harnesses". A reverse-dependency walk (2026-08-05) found no
// caller anywhere — in this repo, the examples, the corpus harness or the docs —
// so the quarantined pipeline no longer has a public surface to be extended
// through. `createApps()` still drives it internally; new work uses the lean
// loop and the checks floor at the paint seam.
// Contract §3.2 — the checkout/commit seam. Public because the workspace half of
// it lives outside this package: a sandboxed harness holds a `WorkspaceFs` and
// never a store, so composition binds the store side once and hands these to
// whoever is materializing an app.
export {
  appMountFor,
  checkoutApp,
  commitApp,
  invalidSourcePath,
  type AppSourceSeam,
} from "./app-source.js";
