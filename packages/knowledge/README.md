# @vendoai/knowledge

`@vendoai/knowledge` is Vendo's product knowledge base: the concrete retrieval engines and the ingestion pipeline that sit behind core's frozen `KnowledgeAdapter` contract (`@vendoai/core`).

One contract, three engines:

- **Built-in local engine** — lexical retrieval over the host's own store (the free tier), reading and writing the `vendo_knowledge_docs` / `vendo_knowledge_chunks` collections.
- **Cloud client** — speaks the knowledge wire protocol (`vendo/knowledge-wire@1`) to a managed backend.
- **BYO HTTP template** — the same wire protocol pointed at a host-supplied endpoint.

Ingestion (parse → normalize → structural chunk → sync) turns a host's local sources into document-level upserts; chunking, embedding, and indexing belong to the engine behind the contract.

The umbrella package wires the resolved adapter into the agent loop so knowledge-backed retrieval grounds chat, generated apps, and action planning with citations, under the same guard policy and audit trail as every other tool.

## Status

Stage 0 scaffold (ENG-355). The package + toolchain are in place; the engines and ingestion land across Stages 1–3 of the knowledge build. See the `@vendoai/knowledge` project in Linear.
