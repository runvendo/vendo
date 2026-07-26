/**
 * @vendoai/knowledge — the product knowledge base (knowledge design v2,
 * 2026-07-22).
 *
 * This package holds the concrete `KnowledgeAdapter` engines — the built-in
 * local lexical engine, the cloud client, and the BYO HTTP template — plus the
 * ingestion pipeline (parse → normalize → structural chunk → sync), all behind
 * core's frozen contract (`@vendoai/core`, ENG-358).
 *
 * Stage 0 (ENG-355) is the scaffold: package + toolchain only. Ingestion lands
 * in Stage 1 (ENG-361/362), the engines in Stage 2 (ENG-363/364/365).
 */

/**
 * The adapter contract every engine in this package implements — re-exported so
 * consumers pull the seam from the package that ships the engines.
 */
export type { KnowledgeAdapter } from "@vendoai/core";

/**
 * The store record collections backing the built-in local engine, created by
 * the store DDL (ENG-356). The local engine reads/writes documents and their
 * chunks through these; the cloud engine keeps its corpus server-side and never
 * touches them.
 */
export const KNOWLEDGE_DOCS_COLLECTION = "vendo_knowledge_docs" as const;
export const KNOWLEDGE_CHUNKS_COLLECTION = "vendo_knowledge_chunks" as const;
