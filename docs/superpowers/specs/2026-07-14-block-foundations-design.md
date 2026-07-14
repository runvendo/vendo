# Block foundations — core + store + agent: gap-closing design

Date: 2026-07-14 · Lead: Yousef · Linear project: "Block: foundations — core + store + agent"
Status: approved by Yousef (brainstorm session, 6 decision rounds)

## Outcome

The three foundational packages provably live up to their vision claims — core
"frozen, tiny, boring, runs anywhere, typed end-to-end"; store "boring
Postgres-only, encrypted, host-queryable"; agent "the loop only, BYO any
provider" — with every closed gap pinned by a conformance test and proven by a
captured demo. The frozen contracts move from "frozen but stale" to "frozen
with a dated amendment log": code and doc agree everywhere, in the direction
Yousef approved per gap.

## Ground truth

Four examination agents read all of packages/core, packages/store,
packages/agent, the cross-package seams, and docs/contracts/00–03 clause by
clause. Full findings with file:line evidence are in the appendix. Overall:
the packages are in good shape (conformance-shaped tests, clean layering, one
provider seam, zero deep imports); the gaps cluster into contract drift,
encryption/retention, session lifecycle, CI holes, loop robustness, and
deploy DX.

## Locked decisions (Yousef, 2026-07-14)

- **Cloud-aligned**: resolved per-gap, not as a blanket rule. The session
  lifecycle, erase API, encryption default-on, audit append-only, and
  real-Postgres CI are the pieces hosted multi-tenant Cloud sits on. Same
  packages run OSS and Cloud; nothing in this plan forks them.
- **Change appetite**: contract amendments allowed — versioned, dated,
  Yousef approves each. Amendment log + stay 0.x; the train goes 1.0 at GA.
- **Store seam**: amend the contract to bless reserved-collection routing as
  THE sanctioned cross-block persistence seam. Do not build the typed-helper
  architecture the old contract text described.
- **Session lifecycle**: design a real one (TTL registry, touch-on-request,
  idle eviction, cascading cleanup) — not just a memory cap.
- **Audit**: append-only enforced in routing; deletion only via the erase API.
- **Encryption**: default-on via `vendo init` generating
  `VENDO_STORE_ENCRYPTION_KEY` into `.env`, picked up by `createVendo`;
  plus AAD binding ciphertext to secret name.
- **Retention**: store-level erase API — by subject, by app, by age —
  cascading across all 13 tables, exposed on the umbrella. This is a
  deliberate amendment of the "retention = host SQL" contract stance.
  Policy engines/schedulers out of scope.
- **RunContext**: promote `grant` and `mcpConsent` into core as optional
  contracted fields; delete the structural twins in actions/mcp.
- **Loop robustness**: all five fixes in scope (abort/cancel, step-cap knob +
  visible exhaustion, persist-failure surfacing, version-checked thread puts,
  abandoned approvals resolved guard-side).
- **Prompt wiring**: fixed in this project — umbrella reads `.vendo/brief.md`
  and assembles catalog + theme into the system config (03 §3 becomes real
  end-to-end).
- **Providers**: first-class matrix = Anthropic + OpenAI + an
  OpenAI-compatible proxy. Wire-format conformance in PR CI (mock/recorded
  transports); live legs nightly with repo secrets; no live keys on PRs.
- **Conformance**: per-package conformance tests named per contract clause;
  a `conformance` CI job becomes a required check. Real-Postgres service in
  PR CI.
- **Deploy DX**: umbrella gains runtime store exports
  (`createStore`/`envSecrets`/`storeSecrets`/`secretStore`) and docs show the
  real import path. Broader quickstart rewrites belong to Install DX
  (cross-link, don't own).
- **Minor hardening**: all four clusters in scope — core validation
  tightening (bytes-not-chars caps, fn: wire gap, Tree.data delegation note),
  store flip-guard parity (apps/grants), agent wire hygiene (prefix constant,
  part-shape reconciliation, upsert validation), compat (CJS export
  condition, open enums per §15).
- **Leftovers**: all four in scope — corpus pack adds `@vendoai/mcp`, mcp
  shim freshness gate, test memory-store consolidation, UI wire-type parity
  test (coordinate with the block-ui session before touching packages/ui).
- **Split call**: decided after this spec — if the session-lifecycle wave's
  plan exceeds ~a week serialized, it becomes a child Orca orchestrator
  session owned by this one.
- **Demo hosts**: both — Maple gets provider-swap + resilience drills;
  Cadence gets Postgres-swap + encryption/retention proof.
- **Execution**: waves below, each wave = one PR, executed by codex sol
  (Opus 4.8 only when sol is usage-blocked), reviewed by this orchestrator.

## Wave plan (docs-first)

### Wave 1 — Contract amendment log (docs only)
Every contract doc (00/01/02/03) gains a dated Amendments section (what
changed, why, approved-by). Amendments: bless reserved-collection routing and
retire the typed-helper fiction (02 §3, 01 §14 note); record `source: "mcp"`
and `door-auth` in 01 proper; un-defer mcp in 00-overview (deferred list,
package table, dependency diagram) and fix 01's "reserved for the deferred
door" note; fix 03's `ai ≥ 5` to the real `>=6 <7`; bless the undocumented
surface siblings already use (core `/conformance` subpath, `canonicalJson` /
`sha256Hex` / other root extras, store `secretStore`); document
`vendo_grants.context_key`; contract the RunContext promotion, the erase API,
and encryption default-on (implemented in later waves); state the Tree.data
size delegation and the per-process ephemeral-overlay multi-instance
constraint.

### Wave 2 — Conformance + CI
Per-package conformance suites named per contract clause; `conformance`
required check. Real-Postgres service in PR CI (the store suite currently
silently halves to PGlite-only). Provider wire-format conformance for the
three-provider matrix in PR CI; nightly workflow runs the live legs
(Anthropic/OpenAI/proxy) plus the existing key-gated live suites. Small
gates: mcp shim regen-and-diff check; corpus local-pack list gains
`@vendoai/mcp`; consolidate the three parallel test memory-stores onto an
upgraded core conformance kit that mirrors reserved-collection routing
semantics; UI wire-type parity test (after syncing with block-ui).

### Wave 3 — Store hardening
Audit append-only in routing (put on existing id errors, delete refused).
AES-GCM AAD binds ciphertext to secret name (with envelope-version handling
for existing rows). Apps and grants get the atomic cross-subject flip refusal
threads already have. Encryption default-on (init generates key, createVendo
reads env). Erase API: by subject / by app / by age, cascading across all 13
tables, the only sanctioned deletion path for audit rows, exposed through the
umbrella.

### Wave 4 — Session lifecycle (the deep one)
Real session semantics for ephemeral principals: TTL-based session registry,
touch-on-request, idle eviction, cascading cleanup of the store overlay and
the agent's in-memory threads. Must respect the known constraint that
ephemerality checks depend on overlay app rows surviving across requests
(naive per-request drop causes disk leaks). Multi-instance behavior
documented as a constraint. Detailed design happens at wave-planning time;
the split decision (child session or not) is made on that plan.

### Wave 5 — Agent loop + seams
AbortSignal through the loop, umbrella wires client disconnect to it.
Configurable step cap with visible exhaustion in the stream. Persist-failure
surfacing and version-checked thread puts (no last-write-wins between
concurrent turns). Abandoned approvals resolved guard-side. Replace the
`vendo_apps_` string-prefix coupling with a core-defined constant. Reconcile
core's flat `VendoViewPart` with the real nested wire shape. Tighten client
message-upsert validation to approval-state transitions. Implement the
RunContext promotion; delete the structural twins. Fix prompt wiring (brief +
catalog + theme). Umbrella runtime store exports + deploy-doc path fix. CJS
export condition on core; open enums per §15 forward-compat.

### Wave 6 — Demos + GIFs (definition of done)
Four captured demos, both hosts:
1. **Provider-swap** (Maple): the same conversation flow on Anthropic,
   OpenAI, and an OpenAI-compatible proxy.
2. **Resilience drills** (Maple): kill-the-server + restart-and-resume
   through the composed stack; client disconnect visibly cancels the loop;
   memory stays flat under anonymous-session churn.
3. **Postgres-swap** (Cadence): PGlite default and real Postgres both
   working, plus host-side SQL querying of the store.
4. **Encryption/retention proof** (Cadence): raw DB inspection shows
   ciphertext (and AAD rejection on tamper); the erase API visibly removes a
   subject's data.

## Out of scope
Typed store helpers refactor; retention policy engines/schedulers; key
rotation; going 1.0 (GA decision); quickstart rewrites beyond the deploy-path
fix (Install DX owns, cross-linked); anything owned by a theme project per
the roadmap overlap rule.

## Coordination
- **block-ui session**: sync before the UI wire-type parity test lands
  (packages/ui is theirs).
- **Install DX project**: file the doc-staleness evidence (XCUT-3/10 beyond
  the deploy-path fix) with cross-links.
- **Linear**: issues created per wave under the foundations project after
  this spec is approved.

## Appendix — full gap inventory (evidence-backed)

Severity: maj = major, min = minor. Every item verified with file:line by the
examination agents on 2026-07-14.

### Core (packages/core vs 01-core.md)
- CORE-1 maj: 01 never amended for post-freeze `source: "mcp"`
  (src/grants.ts:74) and `door-auth` (src/audit.ts:12); only draft 10-mcp
  justifies them.
- CORE-2 maj: load-bearing `ctx.grant` / `ctx.mcpConsent` undefined in core;
  ride through `.passthrough()`; structural twin in
  actions/src/runtime/registry.ts:39-40; guard attaches at guard.ts:811.
- CORE-3 maj: undocumented `/conformance` subpath (608 LOC incl.
  `memoryStoreAdapter`) in a "no behavior, single entry point" package.
- CORE-4 min: undocumented root exports consumed in production
  (`canonicalJson`/`sha256Hex` in ui approval-card.tsx:34 + actions;
  `safeErrorMessage`, `TOOL_NAME_PATTERN`, `TREE_MAX_*`, bindings).
- CORE-5 min: 01 §8 fn: rules only partially enforced by `validateTree`
  (grammar only on query.tool; machine-presence rule impossible there);
  known ESCALATION in contract-coverage.e2e.test.ts:357.
- CORE-6 min: component caps enforced in UTF-16 chars not bytes
  (tree-limits.ts:13-16) vs contracted "64 KB / 256 KB".
- CORE-7 min: no size bound on Tree.data/props (tree-dos.test.ts:121
  documents delegation upstream; contract doesn't warn hosts).
- CORE-8 min: lax `treeSchema`/`appDocumentSchema` accept documents the
  normative validators reject; contract never says schemas are non-normative.
- CORE-9 min: "semver-sacred" published at 0.3.0 — freeze unexpressible to
  installers until 1.0.
- CORE-10 min: ESM-only; CJS hosts on Node <20.19 can't load core.
- CORE-11 min: closed zod enums contradict §15's own forward-compat
  normative (unknown variants must be tolerated).
- CORE-12 info: 00-overview stale on mcp (deferred list, table, diagram).

### Store (packages/store vs 02-store.md)
- STORE-1 maj: ephemeral overlay dropped only at close()
  (store.ts:40-44, ephemeral.ts:69-84); umbrella registers every anon
  subject (vendo/src/server.ts:369) and never drops → unbounded memory.
  Constraint: records-ephemerality checks need overlay rows across requests
  (records.ts:39).
- STORE-2 maj: vendo_audit not append-only through the routed door guard
  uses — upsert at routing.ts:335 / rows.ts:173-175, DELETE at
  routing.ts:223; guard writes via this door (guard.ts:372).
- STORE-3 maj: real-Postgres leg never runs in CI
  (backends.test-util.ts:96-101; ci.yml has no service; perf.yml sets
  POSTGRES_URL but runs bench only).
- STORE-4 maj (drift): contracted typed-helper architecture unbuilt; real
  seam is uncontracted RESERVED_COLLECTIONS routing (routing.ts:50-60);
  README documents reality, contract doesn't.
- STORE-5 min: `secretStore` export (index.ts:4) uncontracted; contract has
  no sanctioned secret-write path at all.
- STORE-6 min: AES-GCM without AAD (crypto.ts:31-37) — cross-row
  ciphertext swap undetected.
- STORE-7 min: flip-guard inconsistency — threads TOCTOU-guarded
  (rows.ts:60-72), apps (rows.ts:31) and grants (rows.ts:129) upsert
  subject.
- STORE-8 min: encryption default-off in shipped composition
  (server.ts:646,687); nothing lights it up.
- STORE-9 min: overlay per-process (WeakMap, ephemeral.ts:20) — multi-
  instance deploys split anon state; undocumented.
- Facts: 13 tables, SCHEMA_VERSION 2; encrypted at rest =
  vendo_secrets.ciphertext ONLY; threads/audit/approvals/records/state/
  apps/runs/blobs plaintext by contract decision 19; no OAuth tokens
  persisted anywhere (mcp stores token hashes only).

### Agent (packages/agent vs 03-agent.md)
- AGENT-1 maj: 03 §3 clause (4) catalog+theme never assembled; prompt.ts:31
  claims the umbrella folds it in — it doesn't.
- AGENT-2 maj: host product brief dead — init writes .vendo/brief.md but
  createVendo never passes `system` (server.ts:692).
- AGENT-3 maj: no cancellation path; no AbortSignal anywhere in src.
- AGENT-4 min: `vendo_apps_` string-prefix coupling (tools.ts:93).
- AGENT-5 min: `ai >=6 <7` peer vs contracted "≥ 5".
- AGENT-6 min: abandoned approvals never resolved guard-side
  (agent.ts:87-102; pinned by abandoned-approval.test.ts:84).
- AGENT-7 min: hardcoded silent 20-step cap (agent.ts:141), untested.
- AGENT-8 min: onFinish persist unhandled (agent.ts:158-160) — silent
  thread loss on store failure.
- AGENT-9 min: lost-update race on concurrent turns (threads.ts persist,
  no CAS).
- AGENT-10 min: core §16 flat VendoViewPart vs real nested
  `{type, data:{appId,payload}}` wire/persisted shape (tools.ts:34-40).
- AGENT-11 min: in-memory threads never evicted (process-lifetime).
- AGENT-12 min: client can upsert arbitrary assistant content by id
  (agent.ts:66-75) — subject-scoped but unvalidated beyond shape.
- Facts: impl 715 LOC; deps = core only + `ai` peer; provider seam =
  exactly `LanguageModel` at two call sites; zero provider branches; only
  Mock + Anthropic-live ever exercised; sole dependent = umbrella via
  public exports; asRunner passes core's conformance kit.

### Cross-cutting
- XCUT-1 maj: 00-overview mcp staleness (= CORE-12).
- XCUT-2 maj: store seam drift (= STORE-4) — 20 files persist via
  records("vendo_*").
- XCUT-3 maj: production-deploy path unreachable — umbrella root is
  type-only, /server exports only createVendo/nextVendoHandler; docs show
  createStore({url}) but never the import path.
- XCUT-4 maj: corpus local-pack list lacks @vendoai/mcp
  (local-pack.ts:7-19) — umbrella injection resolves mcp from npm.
- XCUT-5 maj: no real-Postgres leg anywhere in CI, store-level or composed
  (= STORE-3; fixtures hardcode PGlite, harness.ts:221).
- XCUT-6 maj: 03's ai peer-range drift (= AGENT-5).
- XCUT-7 min: 939KB committed mcp shim has no freshness gate
  (test:mcp-shim not in CI).
- XCUT-8 min: three parallel test memory-stores, none matching reserved-
  collection semantics.
- XCUT-9 min: ui duplicates block wire types verbatim; currently in sync;
  nothing pins it.
- XCUT-10 min: quickstart/reference docs still show 8-package type imports
  post-umbrella (beyond PR #146's one-file fix).
- Layering: dependency-guard passes clean; zero deep imports repo-wide;
  only declared subpath in use is core /conformance.
- Integration coverage holes: composed stack never on real Postgres;
  no restart-and-resume drill through createVendo; provider swap never
  exercised.
