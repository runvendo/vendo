/** `@vendoai/actions/sync` — the build-/dev-time extraction surface (vendo
 *  sync, server-action extraction, the static zod interpreter). Split from
 *  the package root so the RUNTIME entry a server bundles never drags in
 *  node:fs and the TypeScript compiler: the root export used to re-export
 *  these, which put ~4MB of dev tooling (and hard Node deps) into every
 *  Worker bundle. CLI and tests import from here. */
export { mergeOverrides, vendoSync, type SyncReportWithWarnings } from "./index.js";
// The spec's relative server mount, and the document the extractors read it
// from. Stored paths no longer carry the mount (spec 2026-08-06 §B1); doctor
// reads the same two to catch a spec that disagrees with VENDO_BASE_URL's path
// prefix (E-CFG-003), through THIS pair so it can never look at a different
// document than sync did.
export { openApiMountPath } from "./openapi.js";
export { firstOpenApiSpec } from "./extractors.js";
// The judgment layer's deterministic half (direction rule, apply, prune) is
// NOT here: it lives at the package root (src/judgments.ts) because the runtime
// registry applies judgments, and this entry is the node-only build-time half.
export {
  extractServerActions,
  serverActionRegistrations,
  type ServerActionRegistration,
  type ServerActionsExtractResult,
} from "./server-actions.js";
// The static zod → JSON Schema interpreter (04 §1). Exported so the
// composition can pin static/runtime derivation parity in tests — sync's
// static output feeds the ajv-compiled disk validator while the runtime
// derives from the live zod object, and the two must agree.
export {
  parseModule,
  zodFromExpression,
  type FileModule,
  type StaticExtraction,
  type ZodSchemaResult,
} from "./static-ts.js";
