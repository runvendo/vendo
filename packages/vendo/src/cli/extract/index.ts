/**
 * Public seam for the extraction pieces the corpus AI eval matrix consumes
 * (install-dx lane 3). Additive re-exports only — the modules themselves are
 * owned by the init flow.
 *
 * The staged tool-drafting pipeline (`runStagedExtraction`) and its
 * deterministic applier (`applyDraft`) are GONE: tool judgment moved to the
 * judgment channel (`cli/judge/`, `runJudgmentPass`), which grades with quoted
 * evidence and an independent skeptic instead of drafting into overrides.json.
 * What survives here is the prose half — the brief and theme stages — plus the
 * judgment pass itself, which is what the matrix now measures.
 */
export {
  draftToolSchema,
  extractionDraftSchema,
  parseDraft,
  type DraftTool,
  type ExtractionDraft,
  type ExtractionHarness,
  type ExtractionRunInput,
} from "./harness.js";
export {
  applyBrief,
  runBriefStage,
  runThemeStage,
  staticFacts,
  staticToolSchema,
  type BriefStageInput,
  type BriefStageResult,
  type JudgedSummary,
  type StaticTool,
  type ThemeStageInput,
  type ThemeStageResult,
} from "./stages.js";
export { claudeHarness, type ClaudeHarnessOptions } from "./claude-harness.js";
// The judgment channel's entry point. Re-exported HERE rather than behind a new
// `./judge` subpath because this barrel already exists for exactly one consumer
// — the corpus AI matrix — and grading the judgment channel is now that matrix's
// whole job. Owned by the init flow; additive only.
export {
  runJudgmentPass,
  type JudgmentPassCounts,
  type JudgmentPassOptions,
  type JudgmentPassResult,
} from "../judge/pass.js";
