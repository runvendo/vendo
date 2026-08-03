/**
 * Cross-block internals — NOT a host surface.
 *
 * The emitted-payload assembly and the field stripping that goes with it, so
 * @vendoai/harnesses' render seam emits the payload shape THIS emitter emits
 * rather than keeping a drifting copy. Behind a subpath because the only
 * supported consumer is another `@vendoai/*` block, so these stay free to change
 * without a major bump.
 */
export { assembleTree } from "./runtime.js";
export { stripServerAuthoritativeFields } from "./open.js";

/**
 * The Claude Agent SDK turn lives at `@vendoai/apps/claude-turn`, NOT here.
 *
 * This subpath is imported statically by `@vendoai/harnesses`' render seam,
 * which is on every composed host's server path. Re-exporting the SDK turn from
 * it put the turn runner in every host's build graph, and a bundler that folds
 * `import(CONST)` then demanded `@anthropic-ai/claude-agent-sdk` at build time
 * from a host that has no reason to install it. One subpath per reachability
 * class, exactly as `@vendoai/harnesses/claude-code` is separate from
 * `@vendoai/harnesses`.
 */
