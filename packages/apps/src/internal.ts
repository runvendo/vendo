/**
 * Cross-block internals — NOT a host surface.
 *
 * The emitted-payload assembly and the field stripping that goes with it.
 * The render seam that consumes them lives in this package now
 * (`render-seam.ts`) and reaches them relatively; the subpath stays for any
 * other `@vendoai/*` block, so these stay free to change without a major bump.
 */
export { assembleTree } from "./runtime.js";
export { stripServerAuthoritativeFields } from "./open.js";
/**
 * The checks floor, built (§7.1). Composition reaches it through
 * `AppsRuntime.floor(ctx)`, which is the supported path; this export exists so the
 * render seam's own tests can drive the REAL floor rather than a double of it —
 * the seam is a producer/consumer seam, and the repo's standing lesson is that a
 * harness which mocks its counterparty proves nothing.
 */
export { createAppFloor, type AppFloorOptions } from "./checking/floor.js";

/**
 * The Claude Agent SDK turn lives at `@vendoai/apps/claude-turn`, NOT here.
 *
 * This subpath rides every composed host's server path (the render seam and
 * this file share a module graph). Re-exporting the SDK turn from
 * it put the turn runner in every host's build graph, and a bundler that folds
 * `import(CONST)` then demanded `@anthropic-ai/claude-agent-sdk` at build time
 * from a host that has no reason to install it. One subpath per reachability
 * class, exactly as `@vendoai/harnesses/claude-code` is separate from
 * `@vendoai/harnesses`.
 */
