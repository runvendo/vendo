/**
 * Public seam for the extraction pipeline pieces the corpus AI eval matrix
 * consumes (install-dx lane 3). Additive re-exports only — the pipeline
 * itself lives in the sibling modules and is owned by the init flow.
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
export { applyDraft, composeInstructions } from "./extraction.js";
export {
  runStagedExtraction,
  staticToolSchema,
  type StagedExtractionInput,
  type StagedExtractionResult,
  type StaticTool,
} from "./stages.js";
export { claudeHarness, type ClaudeHarnessOptions } from "./claude-harness.js";
