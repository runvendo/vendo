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
