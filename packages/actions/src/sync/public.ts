/** `@vendoai/actions/sync` — the build-/dev-time extraction surface (vendo
 *  sync, server-action extraction, the static zod interpreter). Split from
 *  the package root so the RUNTIME entry a server bundles never drags in
 *  node:fs and the TypeScript compiler: the root export used to re-export
 *  these, which put ~4MB of dev tooling (and hard Node deps) into every
 *  Worker bundle. CLI and tests import from here. */
export { mergeOverrides, vendoSync, type SyncReportWithWarnings } from "./index.js";
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
