/** @vendoai/core — the shapes everything speaks (docs/archive/contracts/01-core.md). */
export * from "./app-document.js";
export * from "./audit.js";
export * from "./catalog.js";
export * from "./capability-miss.js";
export * from "./descriptor-hash.js";
export * from "./errors.js";
export * from "./formats.js";
export * from "./grants.js";
export * from "./guard.js";
export * from "./fetch.js";
export * from "./heartbeat.js";
export * from "./host-seams.js";
export * from "./ids.js";
export * from "./island-ambient.js";
export * from "./island-derived-values.js";
export * from "./jail-modules.js";
export * from "./jcs.js";
export * from "./kit/index.js";
export * from "./principal.js";
export * from "./reshape.js";
export * from "./run-context.js";
export * from "./semantics.js";
export * from "./shape.js";
export * from "./sha256.js";
export * from "./store.js";
export * from "./stream-parts.js";
export * from "./tool-envelopes.js";
export * from "./tools.js";
export * from "./tree.js";
export * from "./tree-v2.js";
export * from "./triggers.js";
// wire-v2 — only the compiler entry point, the renderer/repair issue
// contract, and the per-binding repair shape (v2 spec §3) are public; the
// sibling modules (expressions, attributes, scan, limits, state) stay
// internal. The shape checker itself is public for one consumer: the
// graduation fn-result post-pass (Wave 7 H2), which re-checks an already
// compiled tree once the fn: shapes are sampled.
export { compileWireV2, type WireCompileOptions, type WireCompileResult } from "./wire-v2/compile.js";
export { expandInlineRefs, type InlineRefsResult } from "./wire-v2/inline-refs.js";
export { WIRE_ISSUE_CODES, type WireIssue, type WireIssueCode } from "./wire-v2/expression.js";
// v2 spec §5 — the one-dialect edit surface: print the app as id-anchored
// wire (the model's edit context), apply the model's <Edit> patch.
export { compileWirePatchV2, type PatchExtensionOp, type WirePatchBase, type WirePatchOptions, type WirePatchResult } from "./wire-v2/patch.js";
export { printWireV2, type WirePrintInput, type WirePrintOptions } from "./wire-v2/print.js";
export { checkBindingShapes, type BindingShapeError } from "./wire-v2/shape-check.js";
