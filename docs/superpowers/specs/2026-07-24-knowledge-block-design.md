# Vendo Knowledge: Design and Build

Status: APPROVED by Yousef 2026-07-24. This one document is the whole handoff: design, evals, build order. Foundation = knowledge design v2 (2026-07-22), already frozen on main; the contract files in core are read-only for this work.

## What it is

Hosts connect their product knowledge and the embedded agent answers from it, grounded and cited, refusing when the evidence is weak. One contract, two ingestion doors, four engines, one eval suite that gates all of it.

```
developer door (docs-as-code sync)  ─┐                      ┌─ local lexical (free tier, in the host's store)
                                     ├─ KnowledgeDoc upserts ┤  Agentset (Cloud default, namespace per host)
operator door (console: crawl URL,  ─┘   over one contract   │  RAGFlow (on-prem / second backend)
Notion/Drive via Composio, upload)       + wire protocol     └─ BYO HTTP endpoint (any language)
                                                │
                                    agent: knowledge_search tool
                                    (snippets → fetch read-more → cited answer or refusal)
```

## The frozen contract (read, don't touch: `packages/core/src/knowledge.ts`, `knowledge-wire.ts`, `conformance/knowledge.ts`)

`KnowledgeAdapter`: `search` + `status` required; `fetch` (read-more), `upsert`, `remove` present per declared posture. Docs carry `kind` (docs/glossary/api) and `visibility` (public/internal); queries carry `intent` (chat = fast, deep = agentic, schema = exact lookup with honest not-found). Citations are docId + opaque chunkId. Upsert is document-level (engines own chunking) and must not resolve until searchable. Scores are engine-relative, never comparable across engines. The wire protocol `vendo/knowledge-wire@1` is the HTTP profile of all this, spoken identically by the cloud client and BYO endpoints; tenancy never crosses the wire.

## The two doors

**Developer door**: sync local sources (docs folder, glossary/api files) with explicit kinds/visibility; hash manifest for incremental sync; works offline against the local engine. (Already staged by the design-v2 work on main; check existing tickets before touching ingestion so you don't build it twice.)

**Operator door (Cloud)**: console Knowledge page; paste a docs URL (crawler + scheduled re-crawl), connect Notion/Google Drive through the existing Composio dock, or upload files. Everything becomes ordinary KnowledgeDoc upserts over the same wire with defaulted taxonomy (docs/public, editable). Every acquired document is stored canonically on Vendo's side first: that is the vendor exit hatch and the deletion guarantee (disable knowledge = delete backend corpus + canonical copies + stop the meter, one operation). Source add fails loudly if provisioning fails.

## The engines

- **Local lexical** (free tier): keyword retrieval over the host's own store. Honest in docs that it is keyword-grade.
- **Agentset** (Cloud default): namespace per host, lifecycle Cloud-internal. Due diligence done 2026-07-24, verdict proceed. Two launch blockers from it: namespaces created with a **Vendo-owned vector store** (BYO Turbopuffer, so we hold docs + chunks + vectors), and **adapter-level rate budgeting with backoff** (their 600 rpm limit is enforced per organization, shared across all hosts). Use their document.ready webhooks/job-status API for upsert-until-searchable.
- **RAGFlow** (second backend, after Agentset ships): same wire, dataset per host; the on-prem answer and the standing escape path.
- **BYO**: any host endpoint implementing the five wire routes; posture makes partial implementations first-class. pgvector reference lands in wave 2.

## Agent experience and trust

One `knowledge_search` tool. Tool-layer policy owns intent: chat default, auto-escalate to deep on weak results, schema for glossary/api-targeted queries. Snippets first, fetch read-more only when needed. Sources attach to messages as structured data; the UI renders citation chips. Refusal is per-engine calibrated (engine-relative scores): the tool returns an explicit insufficient-evidence outcome and the agent says it does not know. Engine outage = knowledge-unavailable, said out loud, never silent. Wave 2 reserves the verifier pass (cheap model checks answer-is-entailed-by-citations before send).

## Evals (first-class; this is the quality gate for everything above)

Lives in the eval front door (`docs/eval`), shares judge/pool machinery with the self-improving eval suite lane. Runs against the in-memory adapter and local engine per PR, against each cloud engine nightly. Regressions block release.

1. **Golden set**: ~50 hand-curated Q&A pairs from docs.vendo.run, each with expected source doc ids AND expected answer key points.
2. **Retrieval metrics**: recall@k and MRR against expected doc ids, per engine, per intent. Pass bars calibrated and stored per engine.
3. **Answer metrics**: LLM judge for faithfulness (entailed by cited chunks), citation correctness (each cited source supports its claim), completeness against key points.
4. **Refusal set**: ~15 questions with no answer in the corpus plus paraphrases; any non-refusal is a hard fail, not a score.
5. **End-to-end scenarios** (the real thing, headless against a running instance): connect a fixture docs site → sync completes → ask the agent → grounded answer with correct citation chip; mutate a doc → re-sync → answer changes (records sync-to-answer latency); delete the source → corpus and canonical copies empty → agent refuses; kill the engine → agent says it cannot check the docs.
6. **Per-engine comparison report**: local vs Agentset (vs RAGFlow when it lands). This is also how the RAGFlow swap decision stays measurable.

## Build order (one PR each, working software at every step)

1. **Trust layer + tool policy** (this repo): knowledge_search tool, intent policy, refusal surface, citation chips in UI. Developed against core's `memoryKnowledgeAdapter`. Done when: tool + refusal behavior proven in tests, chips render (screenshot).
2. **Eval suite** (this repo): everything in the Evals section except the live-engine runs; wire per-PR offline run into CI. Done when: suite runs green against memory/local engine and fails loudly when seeded with a bad answer.
3. **Agentset backend** (vendo-web): the five wire routes at the console mount, Agentset client with the two launch blockers, canonical document store, offboard flow. Done when: core's conformance suite passes against the live mount and the eval suite's nightly job runs against it.
4. **Acquisition** (vendo-web): crawler (sitemap-first, page caps and per-host budgets from day one), Composio Notion/Drive sync, scheduler on existing cron, deletions propagate. Done when: docs.vendo.run crawls end-to-end into a test namespace and e2e scenario 5.1-5.3 pass.
5. **Console Knowledge page + metering** (vendo-web): connect/paste/upload UI, per-source freshness and error states, remove-with-guarantee; meter pages ingested + retrievals at the mount. Done when: browser walkthrough with screenshots; metered counts visible for a test org.
6. **RAGFlow backend** (vendo-web, later): same wire, conformance + eval comparison green, on-prem deployment recipe.

## Rules

Never modify the frozen contract or wire (major + Yousef sign-off). Branch + PR per step, never main; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before any PR; UI changes need real-browser screenshots in the PR. When this doc and reality disagree, stop and ask Yousef. Wave 2 (not now): verifier pass, pgvector reference, help-center connectors, GraphRAG.
