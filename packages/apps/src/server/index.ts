/**
 * `@vendoai/apps` — the app engine, node-only.
 *
 * The package root is the 06 §1 public API and nothing else. Everything the
 * runtime uses to get its work done — the generation engine, interchange
 * plumbing, persistence — is internal and reachable only through AppsRuntime.
 * A comment below each export block says why that block is public, because
 * "why is this public?" is the only question this file cannot answer itself.
 *
 * The FORMAT this engine produces lives on the browser-safe sibling door,
 * `@vendoai/apps/contract`. Anything a surface needs to speak about an app —
 * the document, the dialects, the kit, the wire shapes — is there, not here.
 */
export {
  createApps,
  type AppsConfig,
  type AppsRuntime,
  type AuthoredAppResult,
  type AutomationAuthorResult,
  type BoxRequest,
  type BoxResponse,
  type EditFailure,
  type EditResult,
  type OpenSurface,
  type SeedFromInput,
  type PlacementEntry,
  type VersionEntry,
} from "./runtime/runtime.js";
// The slot registry — which slots a host's surfaces mount, reported by the
// surfaces that render them. `AppsRuntime.slots` speaks these shapes, so a
// caller must be able to name them.
export type {
  SlotDescriptor,
  SlotRecord,
  SlotRegistry,
} from "./persistence/slots.js";
export type { SandboxAdapter, SandboxMachine, SandboxResumePolicy } from "./escalation/sandbox.js";
// execution-v2 skin contract (Lane C): the per-app box token and the box env
// assembly Lane B consumes at provision.
export {
  createAppTokens,
  type AppTokens,
} from "./persistence/app-token.js";
export {
  buildEnv,
  type BuildEnvContext,
  type BuiltBoxEnv,
  type InferenceResolver,
} from "./escalation/box-env.js";
// The doctor's view of a machine-bearing app — what `AppsRuntime.machine.report`
// answers with. The converter's own shapes stay internal to it: no public door
// hands one out, and an export is additive the day one does.
export type { AppMachineStatus } from "./escalation/manifest-triggers.js";
export {
  shareSnapshotSchema,
  publishRecordSchema,
  type CloudAppsClient,
  type PublishRecord,
  type ShareSnapshot,
} from "./persistence/cloud.js";
export { inClientApprovalSchema, type InClientApproval } from "./remix/inclient.js";
// The two app-scoped persistence doors, exported so `@vendoai/store` — a
// declared consumer of this package — can prove its erase cascade against the
// REAL writers instead of a hand-rolled copy of the rows they produce.
export { createInClientApprovals, type InClientApprovalAccess } from "./remix/inclient.js";
export { createAppHistory, type AppHistoryAccess } from "./persistence/history.js";
export {
  seedBaselineSchema,
  seedComponentName,
  seedDrift,
  type SeedBaseline,
  type SeedDrift,
} from "../contract/index.js";
export { appVersionHash } from "./remix/version-hash.js";
export {
  type InClientVenueState,
  type InClientVerdict,
  type ReviewStanding,
} from "./remix/inclient.js";
// The review-kind lifecycle vocabulary: the queue entry the console seam lists
// and the rejection record the note surfaces from (AppsRuntime.review is the
// behavior surface).
export type {
  RemixRejection,
  ReviewQueueEntry,
} from "./remix/review.js";
export {
  type ShipDiff,
  type ShipDiffGenerated,
  type ShipDiffPin,
} from "./remix/ship-diff.js";
// HostToolInfo is the tool slice GenerationDependencies (and external
// harnesses) speak.
export type { HostToolInfo } from "./generation/engine.js";
// The automation planner, public because it is one model call over public
// inputs, so a harness can author (and prove the refusal of) an automation plan
// without booting the generation pipeline.
export { planAutomation, type AutomationPlan, type AutomationPlanInput } from "./automation/plan.js";
// The model-capability rule (model-params.ts): which Claude ids still accept
// sampling params, and the output cap for ids a sampling-era provider registry
// does not know. Exported for the umbrella's model ladder — its lazy wrapper
// reports a family id ("vendo-env"), so the resolved rung's REAL id must be
// re-checked at call time. Data-only rule — no engine behavior rides on it.
export {
  acceptsSamplingParams,
  UNKNOWN_MODEL_MAX_OUTPUT_TOKENS,
} from "./runtime/model-params.js";
// The generation seam AppsConfig.pipeline is a slice of.
export type { GenerationDependencies } from "./generation/engine.js";
// What app generation mounts itself with: the tools it declares and the skill
// it teaches the pattern with. The umbrella composes them (`server.ts`), which
// is the only layer holding both these values and the live runtime they act
// through.
export { agentToolDescriptors } from "./doors/agent-tools.js";
export { buildingAppsSkill } from "./skills/building-apps.js";
// Contract §3.2 — the checkout/commit seam. Public because the workspace half of
// it lives outside this package: a sandboxed harness holds a `WorkspaceFs` and
// never a store, so composition binds the store side once and hands these to
// whoever is materializing an app.
export {
  commitApp,
  type AppSourceSeam,
} from "./persistence/app-source.js";
// The hot-path render seam (§1.6) — the commit-intercepting wrap that paints a
// landing `app.tsx`. Public because the workspace it wraps lives
// outside this package: composition fills the harness runtime's `wrapWorkspace`
// slot with it, and a host driving a `WorkspaceFs` with its own harness wraps
// the same way. The hot-path vocabulary (`HOT_PATH_*`, `hotPathAppId`) rides
// along because the sync seams that honor it — mid-turn machine collects, diff
// sync-back — live with the drivers, not here; they reach it through the
// harness runtime's injected `hotPaths` slot.
export {
  HOT_PATH_FILES,
  HOT_PATH_WATCH,
  hotPathAppId,
  paintedIn,
  unpaintedIn,
  viewForWrite,
  wrapWorkspaceForRender,
  type PaintAttempt,
  type RenderSeamOptions,
  type UnpaintedReason,
} from "./generation/render-seam.js";
// The builder's validate gate (§7.1 item 4) — "validate must pass before done",
// as a function any harness's loop can call. Public because the loop that needs
// it is not always ours: a host's own harness driving the same workspace wants
// the same gate, and the alternative is every driver reimplementing the verb
// call.
export {
  repairInstruction,
  validateWrittenApps,
  VALIDATE_TOOL,
  type AppValidationFailure,
} from "./generation/validate-gate.js";
/**
 * Cross-block internals — NOT a host surface, and previously the
 * `@vendoai/apps/internal` subpath. The emitted-payload assembly and the field
 * stripping that goes with it; the render seam that consumes them lives in this
 * package and reaches them relatively.
 */
export { assembleTree } from "./runtime/runtime.js";
export { stripServerAuthoritativeFields } from "../contract/index.js";
/**
 * The checks floor, built (§7.1). Composition reaches it through
 * `AppsRuntime.floor(ctx)`, which is the supported path; this export exists so the
 * render seam's own tests can drive the REAL floor rather than a double of it —
 * the seam is a producer/consumer seam, and the repo's standing lesson is that a
 * harness which mocks its counterparty proves nothing.
 */
export { createAppFloor, type AppFloorOptions } from "./checking/floor.js";
/**
 * The screen toolchain (`AppsConfig.toolchain`) — the adapter slot the gauntlet
 * compiles, type-checks and paints through. Public because the implementation is
 * not always ours: a deployment whose checks run where esbuild, the `typescript`
 * package and the QuickJS build are not reachable writes its own, and it cannot
 * write one against an interface it cannot name.
 */
export {
  ScreenToolchainUnavailable,
  type ScreenPaintInput,
  type ScreenPaintResult,
  type ScreenToolchain,
  type ScreenTransform,
  type ScreenTypecheckInput,
  type ScreenTypecheckResult,
} from "./checking/toolchain.js";
export type { ComponentScreenIssue } from "./checking/component-screen.js";
/**
 * The checks-floor gauntlet itself, exported for the same reason as the floor
 * above: the hand that SYNCS a ported component is not in this package, and a
 * port nothing checked is a port nobody can trust.
 */
export {
  PORTED_SCREEN_DIALECT,
  checkComponentScreen,
  type ComponentScreenCheck,
  type ComponentScreenOptions,
} from "./checking/component-screen.js";
// The component screen's own two facts every writer of one needs: which file it
// is, and the title it gives itself. Public because the hand that SAVES a screen
// is not in this package — the screen agent lives in the umbrella, and a harness
// with its own hands writes the same file — and two spellings of the basename is
// a save that paints nothing.
export { SCREEN_FILE } from "../contract/genui/component/index.js";
export { screenName } from "./checking/component-screen.js";
// The E2B sandbox adapter and the sandbox ladder, previously the
// `@vendoai/apps/{e2b,sandbox-ladder}` subpaths. Both are node-only like
// everything else here, and both are optional-peer-guarded at their own call
// sites, so one door is enough.
export { e2bInstalled, e2bSandbox, type E2BSandboxOptions } from "./escalation/e2b/index.js";
export {
  selectSandbox,
  type CloudSandboxRung,
  type SandboxSelection,
  type SandboxVenue,
} from "./escalation/sandbox-ladder.js";
