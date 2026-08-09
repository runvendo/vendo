/**
 * @vendoai/apps — the app artifact and engine.
 *
 * The package root is the 06 §1 public API and nothing else. Everything the
 * runtime uses to get its work done — the generation engine, interchange
 * plumbing, persistence — is internal and reachable only through AppsRuntime.
 * A comment below each export block says why that block is public, because
 * "why is this public?" is the only question this file cannot answer itself.
 */
export {
  createApps,
  type AppsConfig,
  type AppsRuntime,
  type AuthoredAppResult,
  type BoxRequest,
  type BoxResponse,
  type EditFailure,
  type EditResult,
  type OpenSurface,
  type PlacementEntry,
  type PinForkInput,
  type PinForkResult,
  type PinRebaseResult,
  type VersionEntry,
} from "./runtime.js";
export type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "./sandbox.js";
// execution-v2 skin contract (Lane C): the per-app box token and the box env
// assembly Lane B consumes at provision.
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
// The doctor's view of a machine-bearing app — what `AppsRuntime.machine.report`
// answers with. The converter's own shapes stay internal to it: no public door
// hands one out, and an export is additive the day one does.
export type { AppMachineStatus } from "./manifest-triggers.js";
export {
  shareSnapshotSchema,
  publishRecordSchema,
  type CloudAppsClient,
  type PublishRecord,
  type ShareSnapshot,
} from "./cloud.js";
export {
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
// The review-kind lifecycle vocabulary: the queue entry the console seam lists
// and the rejection record the note surfaces from (AppsRuntime.review is the
// behavior surface).
export type {
  RemixRejection,
  ReviewQueueEntry,
} from "./review.js";
export {
  type ShipDiff,
  type ShipDiffGenerated,
  type ShipDiffPin,
} from "./ship-diff.js";
// HostToolInfo is the tool slice GenerationDependencies (and external
// harnesses) speak.
export type { HostToolInfo } from "./generation/engine.js";
// The plan→layout function. The exports map closes deep imports, and this is a
// pure, deterministic function of the public AppPlan — so a demo or harness
// surface can render a plan's skeleton without booting the engine.
export { skeletonFromPlan, type Skeleton } from "./generation/skeleton.js";
// The automation planner, public for the same reason as the skeleton above: one
// model call over public inputs, so a harness can author (and prove the refusal
// of) an automation plan without booting the generation pipeline.
export { planAutomation, type AutomationPlan, type AutomationPlanInput } from "./automation-plan.js";
// The model-capability rule (model-params.ts): which Claude ids still accept
// sampling params, and the output cap for ids a sampling-era provider registry
// does not know. Exported for the umbrella's model ladder — its lazy wrapper
// reports a family id ("vendo-env"), so the resolved rung's REAL id must be
// re-checked at call time. Data-only rule — no engine behavior rides on it.
export {
  acceptsSamplingParams,
  UNKNOWN_MODEL_MAX_OUTPUT_TOKENS,
} from "./model-params.js";
// The generation seam AppsConfig.pipeline is a slice of.
export type { GenerationDependencies } from "./generation/engine.js";
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
// Contract §3.2 — the checkout/commit seam. Public because the workspace half of
// it lives outside this package: a sandboxed harness holds a `WorkspaceFs` and
// never a store, so composition binds the store side once and hands these to
// whoever is materializing an app.
export {
  checkoutApp,
  commitApp,
  type AppSourceSeam,
} from "./app-source.js";
