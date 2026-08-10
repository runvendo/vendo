/**
 * `@vendoai/apps/contract` — the app format, browser-safe.
 *
 * Everything a surface needs to SPEAK about a generated app: the document
 * envelope, the two genui dialects and their compilers, the kit vocabulary, the
 * island/jail rules, catalog + theme, the checking contract, remix provenance,
 * and the wire shapes `/apps/*` returns. No node built-ins, no model, no store —
 * this door is importable from a browser bundle, which is why `@vendoai/ui`
 * reaches app-generation only through it (enforced in `scripts/dependency-guard.mjs`).
 *
 * The behavior that PRODUCES these shapes lives behind the package root
 * (`@vendoai/apps`), which is node-only.
 */
// app-document — the envelope. It STAYS in `@vendoai/core`: core's own store
// conformance kit validates a stored app row with `appDocumentSchema`
// (`core/src/conformance/memory-store.ts`), and core may not reach upward. The
// door is what matters, so it is re-exported here and consumers read one place.
export {
  appDocumentSchema,
  appMemorySchema,
  appSourceFileSchema,
  pinComponentName,
  pinSchema,
  storageDeclSchema,
  type AppBuildFailure,
  type AppDocument,
  type AppMemory,
  type AppSourceFile,
  type Pin,
  type StorageDecl,
} from "@vendoai/core";
export { validateAppDocument, type AppDocumentValidation } from "./app-validation.js";
// component bundle — the seat's contents, on-disk and on the wire
export * from "./component-bundle.js";
export * from "./component-map.js";
export * from "./fn-references.js";
// The three bundle limits and the payload envelope both dialects speak stay in
// core (the chat wire speaks them too) and are re-exported, never re-declared.
export {
  TREE_MAX_COMPONENT_SOURCE_BYTES,
  TREE_MAX_GENERATED_COMPONENTS,
  TREE_MAX_TOTAL_COMPONENT_BYTES,
} from "@vendoai/core";
export type { PathBinding, ReshapeStep, StateBinding, TreeNode, UIPayload } from "@vendoai/core";
// islands — the seat's rules
export * from "./island-ambient.js";
export * from "./island-derived-values.js";
export * from "./jail-modules.js";
// genui/tree — the compiled tree
export * from "./genui/tree.js";
// genui/wire — the authoring dialect's compiler. Only the entry point, the
// issue contract, the printer and the shape checker are public; the sibling
// modules (attributes, scan, limits, state) stay internal.
export { compileWire, type WireCompileOptions, type WireCompileResult } from "./genui/wire/compile.js";
export { expandInlineRefs, type InlineRefsResult } from "./genui/wire/inline-refs.js";
export {
  isAdvisoryWireIssue,
  WIRE_ADVISORY_ISSUE_CODES,
  WIRE_ISSUE_CODES,
  type WireIssue,
  type WireIssueCode,
} from "./genui/wire/expression.js";
export { printWire, type WirePrintInput, type WirePrintOptions } from "./genui/wire/print.js";
export { checkBindingShapes, type BindingShapeError } from "./genui/wire/shape-check.js";
// genui/plan — the plan dialect written before workers fill anything in
export { compilePlan, type PlanCompileResult, type PlanFacts } from "./genui/plan/compile.js";
export {
  planTabs,
  PLAN_DISPLAYS,
  type AppPlan,
  type PlanDisplay,
  type PlanGroup,
  type PlanLeaf,
  type PlanQuery,
  type PlanServer,
} from "./genui/plan/types.js";
// genui/expr — the brace grammar
export * from "./genui/expr.js";
export * from "./genui/screen.js";
// kit — the component vocabulary
export * from "./kit/index.js";
// catalog + theme — one catalog shape, one summary
export * from "./catalog.js";
export * from "./theme.js";
// screen + floor + checking contract
export * from "./screen.js";
export * from "./app-floor.js";
// seed — remix provenance
export * from "./seed.js";
// host components, receipts, deadlines
export * from "./host-components.js";
export * from "./make-receipt.js";
export * from "./build-deadlines.js";
// the wire shapes `/apps/*` returns, which @vendoai/ui re-exports
export * from "./wire-types.js";
