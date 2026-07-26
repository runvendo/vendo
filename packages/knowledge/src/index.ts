/**
 * @vendoai/knowledge — the product knowledge base (knowledge design v2,
 * 2026-07-22).
 *
 * This package holds the concrete `KnowledgeAdapter` engines — the built-in
 * local lexical engine, the cloud client, and the BYO HTTP template — plus the
 * ingestion pipeline (parse → normalize → structural chunk → sync), all behind
 * core's frozen contract (`@vendoai/core`, ENG-358).
 *
 * Pure re-export barrel, alphabetical by module, append-only (lane
 * coordination rule — ENG-360 appends its tool exports the same way).
 */

export type { KnowledgeAdapter } from "@vendoai/core";
export { cloudKnowledge, type CloudKnowledgeOptions } from "./cloud.js";
export { KNOWLEDGE_CHUNKS_COLLECTION, KNOWLEDGE_DOCS_COLLECTION } from "./collections.js";
export {
  VENDO_KNOWLEDGE_CONFIG_FORMAT,
  ingestSources,
  knowledgeConfigSchema,
  knowledgeSourceConfigSchema,
  structuralChunker,
  type KnowledgeConfig,
  type KnowledgeSourceConfig,
} from "./ingest/index.js";
export { lexicalKnowledge } from "./local/lexical.js";
