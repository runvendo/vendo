/**
 * `@vendoai/vendo/try` — the try surface's public entry (unified try surface,
 * Task 15a). The hosted try venue (the console's Cloudflare Worker) composes
 * `createVendo({ profile, fetch })` per anonymous session from IN-MEMORY
 * artifacts, so the pieces it needs — the synthetic host-API stand-in and the
 * try artifact schemas/format constants — ship as package exports instead of
 * staying private to the `vendo try` CLI. This entry only re-exports the
 * cli/try modules; the schemas there ARE the contract (never a second copy of
 * the `@1` strings), and both venues stay on the exact same shapes.
 */
export { createSyntheticFetch } from "./cli/try/synthetic-fetch.js";
export {
  VENDO_FIXTURES_FORMAT,
  VENDO_USECASES_FORMAT,
  assembleTryProfile,
  fixturesFileSchema,
  tryDepthLevelSchema,
  tryProfileSchema,
  tryStageStatusSchema,
  tryToolSummarySchema,
  usecaseSchema,
  usecasesFileSchema,
  type AssembleTryProfileOptions,
  type FixturesFile,
  type TryDepthLevel,
  type TryProfile,
  type TryStageStatus,
  type TryToolSummary,
  type Usecase,
  type UsecasesFile,
} from "./cli/try/profile.js";
