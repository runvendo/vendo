/**
 * Compatibility barrel — the pipeline pieces live in ./generation/
 * (validation/ for the law detectors, stages/ for repair, verify, and
 * region-parallel; the config/context types sit with the engine). This path
 * is kept so runtime.ts and tests keep importing "./pipeline.js" unchanged.
 */
export type {
  CreateValidator,
  PipelineConfig,
  PipelineContext,
  PipelineEvent,
} from "./generation/engine.js";
export {
  actionBindingsInProps,
  actionFaults,
  hasPayload,
  isMutatingRisk,
  SUBMIT_LABEL,
  type ActionFault,
} from "./generation/validation/actions.js";
export {
  dataClassedProps,
  literalDataFaults,
  type LiteralDataFault,
} from "./generation/validation/literals.js";
export {
  sampleFromShape,
  smokeRenderIslands,
  type SmokeRenderOptions,
} from "./generation/validation/smoke-render.js";
export {
  DISCLAIMER_TEXT,
  isDisclaimerOnlyTree,
  NO_VALID_FIX,
  structuredRepair,
  type StructuredRepairResult,
} from "./generation/stages/repair.js";
export {
  dataDigest,
  dataSightedVerify,
  endPass,
  endPassViolations,
  extractEdit,
} from "./generation/stages/verify.js";
export {
  regionParallelCreate,
  type RegionParallelHooks,
  type RegionParallelResult,
} from "./generation/stages/parallel.js";
