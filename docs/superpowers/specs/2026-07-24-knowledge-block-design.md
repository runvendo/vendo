# Vendo Knowledge: Design and Build

Status: APPROVED by Yousef 2026-07-24; RE-WALKED AND RE-APPROVED in full 2026-07-25 with the console knowledge product added (§Console knowledge product) and the DX rulings below. This one document is the whole handoff: design, evals, build order. Foundation = knowledge design v2 (2026-07-22), already frozen on main; the contract files in core are read-only for this work.

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

Rulings (2026-07-25): both doors confirmed for v1. Freshness v1 = per-source status visible in the console ("last synced", "crawl failing since…"); proactive change alerts are wave 2. Same content arriving through both doors is NOT reconciled in v1 — each source namespaces its own docIds, so nothing collides; duplication is acceptable.

## The engines

- **Local lexical** (free tier): keyword retrieval over the host's own store, in the knowledge-owned collections (`vendo_knowledge_docs`/`vendo_knowledge_chunks`; DDL already on main). Honest in docs that it is keyword-grade. DX ruling (2026-07-25): zero-config — `knowledge: lexicalKnowledge()`; createVendo injects the composed store, docs/examples never show store plumbing. Optional override for hosts who want the knowledge tables in a different database. The full posture ships (search/fetch/upsert/remove/status); the parse→normalize→chunk pipeline lives in `@vendoai/knowledge` (engines behind the wire chunk vendor-side; local engines use this pipeline — a future pgvector reference reuses it).
- **Agentset** (Cloud default): namespace per host, lifecycle Cloud-internal. Due diligence done 2026-07-24, verdict proceed. Two launch blockers from it: namespaces created with a **Vendo-owned vector store** (BYO Turbopuffer, so we hold docs + chunks + vectors), and **adapter-level rate budgeting with backoff** (their 600 rpm limit is enforced per organization, shared across all hosts). Use their document.ready webhooks/job-status API for upsert-until-searchable.
- **RAGFlow** (second backend, after Agentset ships): same wire, dataset per host; the on-prem answer and the standing escape path.
- **BYO**: any host endpoint implementing the five wire routes; posture makes partial implementations first-class. pgvector reference lands in wave 2.

## Agent experience and trust

One `knowledge_search` tool (ships as `vendo_knowledge_search` — conductor ruling 2026-07-25: the agent runtime keeps only `vendo_`-prefixed tools always-active in large-host tool loadouts). Tool-layer policy owns intent: chat default, auto-escalate to deep on weak results, schema for glossary/api-targeted queries. Snippets first, fetch read-more only when needed. Sources attach to messages as structured data; the UI renders citation chips. Refusal is per-engine calibrated (engine-relative scores): the tool returns an explicit insufficient-evidence outcome and the agent says it does not know. Engine outage = knowledge-unavailable, said out loud, never silent. Wave 2 reserves the verifier pass (cheap model checks answer-is-entailed-by-citations before send).

## Console knowledge product (scope B, added 2026-07-25)

The console Knowledge page is a four-panel product, not a connect-and-hope status screen. Structure AND visual design approved by Yousef 2026-07-25: the signed mockups live at `docs/superpowers/specs/2026-07-25-knowledge-ui-mockups.html` (both surfaces, all states — console four panels + embedded-chat citation chips/refusal/knowledge-unavailable). Built UI must match them; deviations go back to Yousef.

1. **Sources** — the operator door above: connect/crawl/upload, per-source doc counts, freshness and error states, sync-now, remove-with-guarantee.
2. **Documents (viewer + editor)** — browse/filter every canonical doc by source/kind/visibility. Console-authored docs are a first-class source: rich-text editor (Tiptap — confirmed by Yousef 2026-07-25 — operators live in Notion, not markdown textareas; modest extension set: headings/bold/italic/lists/links/code/tables), storing **markdown** in the canonical store (never editor JSON — portability + exit hatch + one format shared with crawled docs), fields title/body/kind/visibility, save = live in the index via the same upsert path. The same editor component backs "fix this page" and Gaps' "write the answer". Synced/crawled docs are READ-ONLY with two actions: **exclude from agent** (removes from engine, keeps the canonical copy, survives re-crawls) and **fix this page** (one flow: exclude the original + open a pre-filled console copy). Nothing is ever edited in place, so re-crawls never clobber operator work.
3. **Gaps** — real user questions the corpus couldn't answer. Fed entirely mount-side, no wire change: the mount serves every Cloud search and holds the per-engine calibration bar, so when a query's final pass (after deep escalation) returns only below-bar results it logs a gap candidate (question text only, no end-user identity). Grouped by similarity, ranked by frequency, org-visible only, 90-day retention. "Write the answer" opens a pre-titled console doc — refusal → gap → new doc → answered.
4. **Playground** — runs the identical `knowledge_search` the agent runs (same engine, same thresholds); shows retrieved passages, scores, and the would-answer/would-refuse verdict. The self-serve answer to "why did the agent say it doesn't know?"

Deferred deliberately: end-user answer feedback (needs volume), version history/rollback (sources are versioned upstream; console docs get simple edit history later), per-principal ACLs (standing non-goal).

## Evals (first-class; this is the quality gate for everything above)

Lives in the eval front door (`docs/eval`), shares judge/pool machinery with the self-improving eval suite lane. Runs against the in-memory adapter and local engine per PR, against each cloud engine nightly. Regressions block release.

1. **Golden set**: ~50 hand-curated Q&A pairs from docs.vendo.run, each with expected source doc ids AND expected answer key points.
2. **Retrieval metrics**: recall@k and MRR against expected doc ids, per engine, per intent. Pass bars calibrated and stored per engine.
3. **Answer metrics**: LLM judge for faithfulness (entailed by cited chunks), citation correctness (each cited source supports its claim), completeness against key points.
4. **Refusal set**: ~15 questions with no answer in the corpus plus paraphrases; any non-refusal is a hard fail, not a score.
5. **End-to-end scenarios** (the real thing, headless against a running instance): connect a fixture docs site → sync completes → ask the agent → grounded answer with correct citation chip; mutate a doc → re-sync → answer changes (records sync-to-answer latency); delete the source → corpus and canonical copies empty → agent refuses; kill the engine → agent says it cannot check the docs.
6. **Per-engine comparison report**: local vs Agentset (vs RAGFlow when it lands). This is also how the RAGFlow swap decision stays measurable.

## Build order (one PR each, working software at every step)

1. **Trust layer + tool policy** (this repo): knowledge_search tool, intent policy, refusal surface, citation chips in UI. Refusal is a structured tool outcome (not free text) so tests and evals can assert on it; Gaps needs nothing from this repo (mount-side detection, see §Console knowledge product). Developed against core's `memoryKnowledgeAdapter`. Done when: tool + refusal behavior proven in tests, chips render (screenshot).
2. **Eval suite** (this repo): everything in the Evals section except the live-engine runs; wire per-PR offline run into CI. Done when: suite runs green against memory/local engine and fails loudly when seeded with a bad answer.
3. **Agentset backend** (vendo-web): the five wire routes at the console mount, Agentset client with the two launch blockers, canonical document store (including create/edit ops for console docs and the per-doc exclude flag), mount-side weak-result logging for Gaps, offboard flow. Done when: core's conformance suite passes against the live mount and the eval suite's nightly job runs against it.
4. **Acquisition** (vendo-web): crawler (sitemap-first, page caps and per-host budgets from day one), Composio Notion/Drive sync, scheduler on existing cron, deletions propagate. Done when: docs.vendo.run crawls end-to-end into a test namespace and e2e scenario 5.1-5.3 pass.
5. **Console knowledge product + metering** (vendo-web): the four-panel page from §Console knowledge product (Sources, Documents viewer/editor, Gaps, Playground); meter pages ingested + retrievals at the mount. UI goes through the design pipeline (real mockups approved before build). Done when: browser walkthrough with screenshots of all four panels including the fix-this-page and write-the-answer flows; metered counts visible for a test org.
6. **RAGFlow backend** (vendo-web, later): same wire, conformance + eval comparison green, on-prem deployment recipe.

## Rules

Never modify the frozen contract or wire (major + Yousef sign-off). Branch + PR per step, never main; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before any PR; UI changes need real-browser screenshots in the PR. When this doc and reality disagree, stop and ask Yousef. Wave 2 (not now): verifier pass, pgvector reference, help-center connectors, GraphRAG, proactive doc-change alerts, end-user answer feedback, console-doc edit history.
