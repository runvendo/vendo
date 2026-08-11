/**
 * @vendoai/knowledge — the product knowledge base.
 *
 * This package holds the concrete `KnowledgeAdapter` engines — the built-in
 * local lexical engine, the cloud client, and the BYO HTTP template — plus the
 * ingestion pipeline (parse → normalize → structural chunk → sync) and the
 * `vendo_knowledge_search` agent tool, all behind core's frozen contract
 * (`@vendoai/core`).
 *
 * Pure re-export barrel, alphabetical by module.
 */

export type { KnowledgeAdapter } from "@vendoai/core";

/** The `vendo_knowledge_search` agent tool (tool-layer intent policy,
    structured refusal, read-more) over any adapter. */
export {
  createKnowledgeTools,
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
export { bindKnowledgeStore, vendoKnowledge } from "./local/lexical.js";
/** The static prompt index (boot + sync-state refresh). */
export {
  knowledgeIndexResolver,
  type KnowledgeIndexReaders,
} from "./prompt-note.js";
