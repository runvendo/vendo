# Wave 1 — Contract Amendment Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the four frozen contract docs (00/01/02/03) back into agreement with approved reality via dated, attributed amendments — docs only, zero code changes.

**Architecture:** Each contract doc gains a dated "Amendments" section at the bottom (date, what changed, why, "approved by Yousef 2026-07-14"), and the affected body text is edited in place so the doc reads true top-to-bottom. Amendments that contract *future* work (erase API, RunContext promotion, encryption default-on) are marked "contracted here, ships in Wave 3/5" so readers know doc-leads-code is deliberate.

**Tech Stack:** Markdown only. Source of truth for every decision: `docs/superpowers/specs/2026-07-14-block-foundations-design.md` (spec + gap appendix). Linear: ENG-234.

**Ground rules for the executor:**
- Do NOT touch any file outside `docs/contracts/`. This wave is docs-only.
- Do NOT invent policy. Every amendment below was decided by Yousef; if body text seems to need a decision not listed here, stop and escalate to the orchestrator.
- Match each doc's existing voice and structure (terse, numbered sections, decision-log style).
- CORE-6 (bytes vs chars) gets NO amendment: the contract already says bytes; the code moves to bytes in Wave 5. Doc stays as is.

---

### Task 1: Read the inputs

**Files:**
- Read: `docs/superpowers/specs/2026-07-14-block-foundations-design.md` (Wave 1 section + appendix)
- Read: `docs/contracts/00-overview.md`, `01-core.md`, `02-store.md`, `03-agent.md` in full
- Reference (evidence only, do not edit): `docs/contracts/10-mcp.md`, `packages/store/README.md`, `packages/store/src/routing.ts`, `packages/core/src/index.ts`

- [x] **Step 1:** Read the spec's Wave 1 section and the full gap appendix; list the gap IDs this wave closes: CORE-1, CORE-3, CORE-4, CORE-7 (doc note), CORE-12/XCUT-1, STORE-4/XCUT-2, STORE-5, STORE-9 (doc note), AGENT-5/XCUT-6, plus forward-contracting of CORE-2, erase API, encryption default-on.
- [x] **Step 2:** Read all four contract docs end-to-end before editing anything.

### Task 2: Amend 00-overview.md (mcp un-deferral)

**Files:**
- Modify: `docs/contracts/00-overview.md`

- [x] **Step 1:** Remove `mcp` from the "deferred entirely" list (line ~20); leave meter/memory/knowledge/evals deferred.
- [x] **Step 2:** Add an `mcp` row to the package table (~lines 8–18) and an mcp edge to the dependency diagram (~lines 26–30), consistent with reality: `@vendoai/mcp → core` only (per `scripts/dependency-guard.mjs`), consumed by the umbrella; contract lives in 10-mcp.md.
- [x] **Step 3:** Add the dated Amendments section recording: mcp un-deferred (built + contracted in wave 6 of v0; overview missed in that update — 02-store was updated at the time, 00/01/03 were not).
- [x] **Step 4:** Re-read the edited doc top-to-bottom for internal contradictions (any remaining "deferred" mentions of mcp).
- [x] **Step 5:** Commit: `docs(contracts): amend 00-overview — un-defer mcp (XCUT-1/CORE-12)`.

### Task 3: Amend 01-core.md

**Files:**
- Modify: `docs/contracts/01-core.md`

- [x] **Step 1:** §5 `PermissionGrant.source`: add `"mcp"` to the pinned union; §7 `AuditEvent.kind`: add `"door-auth"`. Cross-reference 10-mcp as their origin (CORE-1).
- [x] **Step 2:** Fix the §"reserved" note (~line 46) that calls mcp "the deferred door".
- [x] **Step 3:** §3 `RunContext`: contract optional `grant?: PermissionGrant` and `mcpConsent` fields (shapes per the existing structural twin in `packages/actions/src/runtime/registry.ts:39-40`), marked "contracted here, implemented in Wave 5; until then they ride through passthrough" (CORE-2).
- [x] **Step 4:** Bless the real export surface (CORE-3/4): document the `./conformance` subpath (purpose: contract-conformance kits + `memoryStoreAdapter`; explicitly test-infrastructure surface, exempt from the "no behavior" rule which continues to govern the root) and the root extras siblings consume (`canonicalJson`, `sha256Hex` — noting the exact-grant `inputHash` algorithm is `sha256:` over `canonicalJson(args)` — plus `safeErrorMessage`, `TOOL_NAME_PATTERN`, `TREE_MAX_*`, `RESERVED_COMPONENT_NAMES`, `PathBinding`/`StateBinding` + guards). Amend the "single entry point" sentence accordingly.
- [x] **Step 5:** §8: add the Tree.data/props size delegation note — core does not bound them; hosts must enforce request-body limits (CORE-7, evidence pinned in `tree-dos.test.ts`).
- [x] **Step 6:** Add the dated Amendments section covering steps 1–5.
- [x] **Step 7:** Re-read the doc; commit: `docs(contracts): amend 01-core — mcp additions, real export surface, RunContext promotion (CORE-1/2/3/4/7)`.

### Task 4: Amend 02-store.md

**Files:**
- Modify: `docs/contracts/02-store.md`

- [ ] **Step 1:** Rewrite §3: retire the typed-helper architecture text; bless reserved-collection routing as THE sanctioned cross-block persistence seam (STORE-4/XCUT-2). State: blocks persist through core's `StoreAdapter.records()/blobs()` using reserved `vendo_*` collection names; the store's routing layer maps them to dedicated tables; the reserved-name list mirrors `RESERVED_COLLECTIONS` in `packages/store/src/routing.ts`; `records()` with non-reserved names remains app data. Keep the trusted-caller trust-boundary framing that already governs the door.
- [ ] **Step 2:** In the §2 table map, document per-door semantics for `vendo_audit`: append-only will be *enforced* at routing (put on existing id errors, delete refused) — marked "contracted here, enforced in Wave 3" (STORE-2); deletion only via the erase API.
- [ ] **Step 3:** §1 exports: add `secretStore` (set/delete/list) as the sanctioned secret-write path (STORE-5).
- [ ] **Step 4:** §2 key columns: add `vendo_grants.context_key` (required by 05 §2 step 3; omission was a contract-internal miss).
- [ ] **Step 5:** New retention subsection replacing the "retention = host SQL" stance: store-level erase API — by subject (full erasure), by app, by age — cascading across all 13 tables, exposed on the umbrella, the only sanctioned deletion path for audit rows; host SQL remains available for everything else. Marked "contracted here, ships in Wave 3".
- [ ] **Step 6:** §4 encryption: state the default-on composition — `vendo init` provisions `VENDO_STORE_ENCRYPTION_KEY` in `.env`, `createVendo` picks it up from env; AES-GCM gains AAD binding ciphertext to secret name with envelope versioning. Marked "contracted here, ships in Wave 3" (STORE-6/8).
- [ ] **Step 7:** §4 ephemeral: replace the unimplementable "dropped at session end" sentence with current truth (overlay drops at `close()`; per-process, so multi-instance deployments split anonymous-session state — STORE-1/9) plus a forward pointer: real session lifecycle is Wave 4 scope and will amend this section again when designed.
- [ ] **Step 8:** Add the dated Amendments section covering steps 1–7.
- [ ] **Step 9:** Re-read the doc; commit: `docs(contracts): amend 02-store — bless routing seam, erase API, encryption default-on, audit append-only (STORE-1/2/4/5/6/8/9)`.

### Task 5: Amend 03-agent.md

**Files:**
- Modify: `docs/contracts/03-agent.md`

- [ ] **Step 1:** Fix the header dependency line: `ai` peer is `>=6.0.0 <7`, not "≥ 5" (AGENT-5/XCUT-6).
- [ ] **Step 2:** Add the dated Amendments section recording the fix (manifests always shipped the v6 train; doc lagged).
- [ ] **Step 3:** Re-read the doc; commit: `docs(contracts): amend 03-agent — ai peer range >=6 <7 (AGENT-5)`.

### Task 6: Cross-check and verify

**Files:**
- Read: all four amended docs

- [ ] **Step 1:** Verify every Wave 1 gap ID from Task 1 Step 1 maps to a landed amendment; list the mapping in the task output.
- [ ] **Step 2:** Grep `docs/contracts/` for leftover contradictions: `grep -rn "deferred" docs/contracts/00-overview.md docs/contracts/01-core.md | grep -i mcp` (expect no hits claiming mcp deferred); `grep -n "≥ 5\|>= 5" docs/contracts/03-agent.md` (expect none).
- [ ] **Step 3:** Run `pnpm lint && pnpm typecheck && pnpm test` — expected all green and untouched by this wave (docs-only); this proves no test pins the old doc text.
- [ ] **Step 4:** Final commit if anything moved in steps 1–2; then open the PR titled `docs(contracts): Wave 1 amendment log — foundations gap closure (ENG-234)` with a body linking ENG-234 and the spec file, and a per-doc summary of amendments.

---

## Self-review (done at write time)

- Spec coverage: every Wave 1 bullet in the spec maps to Task 2–5 steps; CORE-6 deliberately excluded (doc already correct — code catches up in Wave 5); CORE-8 excluded (not approved for this wave).
- No placeholders; no code (docs-only wave); paths exact.
- Consistency: amendment forward-markers ("ships in Wave 3/5") match the spec's wave assignments.
