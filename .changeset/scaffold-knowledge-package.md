---
"@vendoai/knowledge": patch
---

Scaffold `@vendoai/knowledge` — the package that will hold the KnowledgeAdapter engines (local, cloud client, BYO HTTP template) and ingestion, behind core's frozen contract. Stage 0: package + toolchain only, exporting the store collection names the local engine binds to (`vendo_knowledge_docs` / `vendo_knowledge_chunks`). Added to the fixed version-lockstep group.
