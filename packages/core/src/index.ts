/** @vendoai/core — the shapes everything speaks (docs/archive/contracts/01-core.md). */
export * from "./app-access.js";
export * from "./app-document.js";
export * from "./audit.js";
export * from "./build-deadlines.js";
export * from "./catalog.js";
export * from "./capability-miss.js";
export * from "./descriptor-hash.js";
export * from "./errors.js";
export * from "./formats.js";
export * from "./grants.js";
export * from "./grant-sets.js";
export * from "./guard.js";
export * from "./fetch.js";
export * from "./heartbeat.js";
export * from "./host-seams.js";
export * from "./ids.js";
export * from "./island-ambient.js";
export * from "./island-derived-values.js";
export * from "./jail-modules.js";
export * from "./jcs.js";
export * from "./knowledge.js";
export * from "./knowledge-wire.js";
export * from "./meter-exhausted.js";
export * from "./model-seats.js";
export * from "./kit/index.js";
export * from "./pack.js";
export * from "./principal.js";
export * from "./reshape.js";
export * from "./product-slug.js";
export * from "./run-context.js";
export * from "./semantics.js";
export * from "./shape.js";
export * from "./sha256.js";
export * from "./skills.js";
export * from "./store.js";
export * from "./stream-parts.js";
export * from "./tool-envelopes.js";
export * from "./tools.js";
export * from "./genui/expr.js";
export * from "./genui/tree-node.js";
export * from "./genui/tree.js";
export * from "./filesystem.js";
export * from "./triggers.js";
export * from "./workspace.js";
// genui/wire — only the compiler entry point, the renderer/repair issue
// contract, and the per-binding repair shape (v2 spec §3) are public; the
// sibling modules (expressions, attributes, scan, limits, state) stay
// internal. The shape checker itself is public for one consumer: the
// graduation fn-result post-pass (Wave 7 H2), which re-checks an already
// compiled tree once the fn: shapes are sampled.
export { compileWire, type WireCompileOptions, type WireCompileResult } from "./genui/wire/compile.js";
export { expandInlineRefs, type InlineRefsResult } from "./genui/wire/inline-refs.js";
export { WIRE_ISSUE_CODES, type WireIssue, type WireIssueCode } from "./genui/wire/expression.js";
// v2 spec §5 — the one-dialect edit surface: print the app as id-anchored
// wire (the model's edit context).
export { printWire, type WirePrintInput, type WirePrintOptions } from "./genui/wire/print.js";
// The brain's edit surface: exact old/new text edits over the id-free print,
// and the recompile that carries node ids across them.
export {
  applyTextEdits,
  recompileWithIdentity,
  type TextEdit,
  type TextEditResult,
} from "./genui/wire/text-edit.js";
export { checkBindingShapes, type BindingShapeError } from "./genui/wire/shape-check.js";
// genui/plan — the plan dialect the brain writes before workers fill anything
// in (generation pipeline rebuild, "Locked interfaces"): the flat AppPlan
// shape plus its compiler, whose fact checks speak sentences, not codes.
export { compilePlan, type PlanCompileResult, type PlanFacts } from "./genui/plan/compile.js";
export {
  planTabs,
  type AppPlan,
  type PlanGroup,
  type PlanIsland,
  type PlanLeaf,
  type PlanQuery,
  type PlanServer,
} from "./genui/plan/types.js";

// The harness contract (build contract 2026-07-30 §1) plus the two seams it is
// typed against: the workspace filesystem (§3.2, lane B) and the model seats
// (§4, lane D). Type-only by design — `defineHarness` and the runtime live in
// @vendoai/harnesses (§2), so core stays the shapes every block may speak.
export type {
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
// `Seat` / `ResolvedModels` come from `./model-seats.js` through the star export
// above. They were ALSO re-exported here from a second, lane-A copy in
// `./models.ts` — four seats instead of five, non-generic, and typed against the
// ai-SDK's `LanguageModel`, which put an `ai` import in core for one type. The
// explicit re-export won over the star, so core's public `Seat` was silently
// missing `verifier` and `Turn.models` could not describe the verifier seat.
// Lane A's own file said "if lane D's version differs, lane D's wins"; it does,
// so the copy is gone and there is one definition.

// Deprecated aliases from the pre-de-versioning naming (0.4.x). Remove next minor.
/** @deprecated Use compileWire. */
export { compileWire as compileWireV2 } from "./genui/wire/compile.js";
/** @deprecated Use printWire. */
export { printWire as printWireV2 } from "./genui/wire/print.js";
/** @deprecated Use validateTree. */
export { validateTree as validateTreeV2 } from "./genui/tree.js";
/** @deprecated Use VENDO_TREE_FORMAT. */
export { VENDO_TREE_FORMAT as VENDO_TREE_FORMAT_V2 } from "./formats.js";
/** @deprecated Use treeSchema. */
export { treeSchema as treeV2Schema } from "./genui/tree.js";
/** @deprecated Use treeQuerySchema. */
export { treeQuerySchema as treeQueryV2Schema } from "./genui/tree.js";
/** @deprecated Use Tree. */
export type { Tree as TreeV2 } from "./genui/tree.js";
/** @deprecated Use TreeQuery. */
export type { TreeQuery as TreeQueryV2 } from "./genui/tree.js";
