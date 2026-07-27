/**
 * @vendoai/knowledge — the product knowledge base (knowledge design v2,
 * 2026-07-22).
 *
 * This package holds the concrete `KnowledgeAdapter` engines — the built-in
 * local lexical engine, the cloud client, and the BYO HTTP template — plus the
 * ingestion pipeline (parse → normalize → structural chunk → sync) and the
 * `vendo_knowledge_search` agent tool, all behind core's frozen contract
 * (`@vendoai/core`, ENG-358).
 *
 * Pure re-export barrel, alphabetical by module.
 */

export type { KnowledgeAdapter } from "@vendoai/core";

/** Knowledge K1 — the `vendo_knowledge_search` agent tool (tool-layer intent
    policy, structured refusal, read-more) over any adapter. */
export {
  createKnowledgeTools,
  KNOWLEDGE_VERIFY_TURN_BUDGET_MS,
  toCitation,
  VENDO_KNOWLEDGE_RESULT_KIND,
  VENDO_KNOWLEDGE_SEARCH_TOOL,
  type KnowledgeCitation,
  type KnowledgeResultEnvelope,
  type KnowledgeResultOutcome,
  type KnowledgeToolsOptions,
} from "./agent-tools.js";
export { cloudKnowledge, type CloudKnowledgeOptions } from "./cloud.js";
export { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "./collections.js";
export { httpKnowledge, type HttpKnowledgeOptions } from "./http.js";
export {
  VENDO_KNOWLEDGE_CONFIG_FORMAT,
  ingestSources,
  knowledgeConfigSchema,
  knowledgeSourceConfigSchema,
  structuralChunker,
  type KnowledgeConfig,
  type KnowledgeSourceConfig,
} from "./ingest/index.js";
export { bindKnowledgeStore, lexicalKnowledge } from "./local/lexical.js";
/** Knowledge K14 — the verifier pass itself (cheap model, capped, fail-open). */
export {
  entailmentVerifier,
  KNOWLEDGE_VERIFY_TIMEOUT_MS,
  type EntailmentVerifierOptions,
  type KnowledgeVerdict,
  type KnowledgeVerifier,
  type KnowledgeVerifierInput,
  type KnowledgeVerifierPassage,
  type KnowledgeVerifyOptions,
} from "./verifier.js";
