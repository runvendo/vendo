---
"@vendoai/store": minor
---

Add the dedicated knowledge record collections `vendo_knowledge_docs` / `vendo_knowledge_chunks` (MCP-door table layout: id/data/refs/created_at/updated_at, GIN index on refs, newest-first keyset index) and bump `SCHEMA_VERSION` 4→5 so existing databases actually create them (the DDL loop only runs while `version < SCHEMA_VERSION` — review fix F1). Both tables join the erase-by-subject/app cascade.
