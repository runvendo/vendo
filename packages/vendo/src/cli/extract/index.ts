/**
 * Public seam for the extraction pieces the corpus AI eval matrix consumes
 * (install-dx lane 3). Additive re-exports only — the modules themselves are
 * owned by the init flow.
 *
 * The staged tool-drafting pipeline (`runStagedExtraction`) and its
 * deterministic applier (`applyDraft`) are GONE: tool judgment moved to the
 * judgment channel (`cli/judge/`, `runJudgmentPass`), which grades with quoted
 * evidence and an independent skeptic instead of drafting into overrides.json.
 * What survives here is the prose half — the brief and theme stages.
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
