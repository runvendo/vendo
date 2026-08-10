/**
 * `@vendoai/apps/testing` — the published test surface, and nothing else.
 *
 * These three are what a consumer outside this package writes tests with: the
 * ONE in-memory implementation of the sandbox files seam, and the deterministic
 * language model. Every other fixture in this directory is ours (the fakes, the
 * guard and store doubles, the seeds); this package's own tests import them from
 * their module, so they stay free to change without a major bump.
 */
export { inMemoryBoxFiles } from "./box-files.js";
export { scriptedLanguageModel, type ScriptedModelCall } from "./scripted-model.js";
/**
 * The sandbox-adapter conformance suite a BYO adapter proves itself against —
 * previously its own `@vendoai/apps/adapter-conformance` subpath.
 *
 * It belongs HERE and not on the package root: it imports `vitest`, and the
 * root rides every composed host's server path, so folding it up there put a
 * test runner in `vendo sync`'s module graph and killed `next build`. One
 * subpath per reachability class — the same law the SDK turn obeys.
 */
export {
  sandboxAdapterConformance,
  type SandboxConformanceHarness,
} from "./adapter-conformance.js";
