/** @vendoai/core — the shapes everything speaks. */
export * from "./agent-context.js";
export * from "./app-access.js";
export * from "./app-document.js";
export * from "./app-floor.js";
export * from "./audit.js";
export * from "./build-deadlines.js";
export * from "./catalog.js";
export * from "./capability-miss.js";
export * from "./descriptor-hash.js";
export * from "./errors.js";
export * from "./formats.js";
export * from "./box-ports.js";
export * from "./grants.js";
export * from "./grant-sets.js";
export * from "./guard.js";
export * from "./fetch.js";
export * from "./heartbeat.js";
export * from "./host-components.js";
export * from "./host-seams.js";
export * from "./ids.js";
export * from "./island-ambient.js";
export * from "./island-derived-values.js";
export * from "./jail-modules.js";
export * from "./jcs.js";
export * from "./knowledge.js";
export * from "./make-receipt.js";
export * from "./knowledge-wire.js";
export * from "./meter-exhausted.js";
export * from "./model-seats.js";
export * from "./kit/index.js";
export * from "./capability.js";
export * from "./principal.js";
export * from "./reshape.js";
export * from "./product-slug.js";
export * from "./prompt-blocks.js";
export * from "./run-context.js";
export * from "./screen.js";
export * from "./semantics.js";
export * from "./shape.js";
export * from "./sha256.js";
export * from "./skills.js";
export * from "./sse-keepalive.js";
export * from "./store.js";
export * from "./store-wire.js";
export * from "./theme.js";
export * from "./stream-parts.js";
export * from "./tool-envelopes.js";
export * from "./tools.js";
export * from "./url.js";
export * from "./genui/expr.js";
export * from "./genui/tree-node.js";
export * from "./genui/tree.js";
export * from "./genui/screen.js";
export * from "./filesystem.js";
export * from "./triggers.js";
export * from "./workspace.js";
// genui/wire — only the compiler entry point, the renderer/repair issue
// contract, and the per-binding repair shape (v2 spec §3) are public; the
// sibling modules (expressions, attributes, scan, limits, state) stay
// internal. The shape checker itself is public for one consumer: the
// graduation fn-result post-pass, which re-checks an already compiled tree
// once the fn: shapes are sampled.
export { compileWire, type WireCompileOptions, type WireCompileResult } from "./genui/wire/compile.js";
export { expandInlineRefs, type InlineRefsResult } from "./genui/wire/inline-refs.js";
export {
  isAdvisoryWireIssue,
  WIRE_ADVISORY_ISSUE_CODES,
  WIRE_ISSUE_CODES,
  type WireIssue,
  type WireIssueCode,
} from "./genui/wire/expression.js";
// v2 spec §5 — the one-dialect edit surface: print the app as id-anchored
// wire (the model's edit context).
export { printWire, type WirePrintInput, type WirePrintOptions } from "./genui/wire/print.js";
export { checkBindingShapes, type BindingShapeError } from "./genui/wire/shape-check.js";
// genui/plan — the plan dialect written before workers fill anything in: the
// flat AppPlan shape plus its compiler, whose fact checks speak sentences,
// not codes.
export { compilePlan, type PlanCompileResult, type PlanFacts } from "./genui/plan/compile.js";
export {
  planTabs,
  PLAN_DISPLAYS,
  type AppPlan,
  type PlanDisplay,
  type PlanGroup,
  type PlanIsland,
  type PlanLeaf,
  type PlanQuery,
  type PlanServer,
} from "./genui/plan/types.js";

// The harness contract plus the two seams it is typed against: the workspace
// filesystem and the model seats. Type-only by design — `defineHarness` and the
// runtime live in @vendoai/harnesses, so core stays the shapes every block may
// speak.
export type {
  BeatPhase,
  DeniedNeeds,
  Harness,
  HarnessEvent,
  SkillListing,
  ToolListing,
  ToolResult,
  Turn,
  TurnSkills,
  TurnState,
  TurnTools,
} from "./harness.js";
export type { CommitResult, WorkspaceFs } from "./workspace.js";
export { WORKSPACE_INLINE_MAX_BYTES, appRootPath } from "./workspace.js";
export type { AppMount } from "./workspace.js";
export { otelTelemetry } from "./otel-telemetry.js";
export type { TelemetryLane } from "./otel-telemetry.js";
