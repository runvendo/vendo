/**
 * The store record collections backing the built-in local engine, created by
 * the store DDL (ENG-356). The local engine reads/writes documents and their
 * chunks through these; the cloud engine keeps its corpus server-side and never
 * touches them.
 */
export const KNOWLEDGE_DOCS_COLLECTION = "vendo_knowledge_docs" as const;
export const KNOWLEDGE_CHUNKS_COLLECTION = "vendo_knowledge_chunks" as const;
