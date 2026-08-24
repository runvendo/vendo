/**
 * `@vendoai/apps/contract` — the app format, browser-safe.
 *
 * Everything a surface needs to SPEAK about a generated app: the document
 * envelope, the tree, the kit vocabulary, the in-client module rules, catalog +
 * theme, the checking contract, remix provenance,
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
  appBuildProposalSchema,
  appBundleSchema,
  appDocumentSchema,
  appMemorySchema,
  appSourceFileSchema,
  appSeedSchema,
  seedComponentName,
  storageDeclSchema,
  type AppBuildFailure,
  type AppBuildProposal,
  type AppBundle,
  type AppDocument,
  type AppMemory,
  type AppSeed,
  type AppSourceFile,
  type StorageDecl,
} from "@vendoai/core";
export { refuseBundleArtifact, validateAppDocument, type AppDocumentValidation } from "./app-validation.js";
// the one door in — every app write passes admission; validateAppDocument above
// is its inner half
export * from "./admission.js";
// the stored row, one definition (was five)
export * from "./app-row.js";
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
export * from "./screen-tools-scan.js";
// genui/tree — the compiled tree
export * from "./genui/tree.js";
export { checkBindingShapes, type BindingShapeError } from "./genui/shape-check.js";
// genui/expr — the brace grammar
export * from "./genui/expr.js";
export * from "./genui/screen.js";
// genui/component — the sealed screen engine (Preact in the VM)
export * from "./genui/component/index.js";
// kit — the component vocabulary
export * from "./kit/index.js";
// catalog + theme — one catalog shape, one theme line
export * from "./catalog.js";
// the briefing pack — one assembly, both rungs
export * from "./briefing.js";
export * from "./theme.js";
// screen + floor + checking contract
export * from "./screen.js";
// build — the other engine's seam
export * from "./build.js";
export * from "./app-floor.js";
// seed — remix provenance
export * from "./seed.js";
// host components, receipts, deadlines
export * from "./host-components.js";
export * from "./make-receipt.js";
export * from "./build-deadlines.js";
// the wire shapes `/apps/*` returns, which @vendoai/ui re-exports
export * from "./wire-types.js";
