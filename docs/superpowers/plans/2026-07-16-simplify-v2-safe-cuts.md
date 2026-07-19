# Simplify-v2 Safe Cuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every kill-list item from `docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` that is safe before the apps/format rebuild.

**Approach:** Two waves. Wave 1 is pure deletions — each task removes one dead sub-feature end to end (code, exports, tests, one-line contract-doc amendment) and lands green. Wave 2 is structural shrinks — behavior-preserving rewrites done test-first. The apps package and the generation pipeline are out of scope (owned by the format-gen-v2 merge point), as are the two extraction/theme rebuilds (B1, B2), which get their own plans.

**Scope guard (locked upstream):** only non-apps packages are cleaned before the rebuild. No task below edits `packages/apps` internals.

**Per-task ritual:** every task ends with `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green and one commit. Where a cut contradicts a frozen contract doc in `docs/contracts/`, the task adds a one-line "removed by simplify-v2 kill-list (2026-07-16)" amendment to that doc — contracts are unfrozen for v2.

**Deferred, with reasons (do not implement):**
- A7 SHA-256 replacement — `packages/ui/src/chrome/approval-card.tsx` hashes synchronously in the browser; WebCrypto would force an async ripple. Re-derivation decides.
- A6 `resolveRisk` hook — its only consumer is the app-tools permission path the rebuild deletes.
- A7 `unified-diff.ts`, interchange machine-legs, pin-parser moves — live in `packages/apps`.

---

## Wave 1 — pure deletions

### Task 1: Cut orgs-in-OSS (A5) — ui client surface
**Files:** `packages/ui/src/hooks/use-orgs.ts` (delete), `packages/ui/src/client-impl.ts` (orgs block), `packages/ui/src/client.ts` (org types), `packages/ui/src/index.ts` (exports), colocated tests.
- [ ] Delete the hook, the client bindings, the exported types, and their tests
- [ ] Full gate green; commit

### Task 2: Cut orgs-in-OSS (A5) — umbrella surface
**Files:** `packages/vendo/src/orgs.ts` (shrink to a stub whose every method answers `cloud-required`), `packages/vendo/src/server.ts` (org wire routes and the three `adminContext` scoping call sites revert to plain ctx), `packages/vendo/src/index.ts`, `packages/vendo/src/orgs.test.ts` + org cases in `server.test.ts`.
- [ ] Update tests first: org routes now answer `cloud-required` regardless of key; entitlement-fetch tests die with the data paths
- [ ] Shrink the module and routes; keep the seam response
- [ ] Full gate green; commit

### Task 3: Cut orgs-in-OSS (A5) — automations and guard branches
**Files:** `packages/automations/src/engine.ts:469-472` (org-principal run branch), `packages/guard/src/guard.ts:488` (org approval branch), their tests.
- [ ] Update tests: automations always run as user principals; guard has no org path
- [ ] Remove both branches
- [ ] Full gate green; commit

### Task 4: Cut orgs-in-OSS (A5) — store layer
**Files:** `packages/store/src/helpers/orgs.ts` (delete), `packages/store/src/schema.ts` (`vendo_orgs`, `vendo_org_members` tables), `packages/store/src/helpers/subjects.ts` (`transferAppSubject`), `packages/store/src/erase.ts:163-169` (org branch), `packages/store/src/db.ts` (`withOrgMembershipLock`), store exports and tests.
- [ ] Update tests first, then delete; keep `kind:"org"` in `core/principal.ts` untouched (contract-time decision) but remove now-unconsumed org-subject helpers if nothing imports them after Tasks 1–3
- [ ] Amend `docs/contracts/02-store.md`
- [ ] Full gate green; commit

### Task 5: Cut constrained grant scopes (A4)
**Files:** `packages/core/src/grants.ts` (the `constrained` GrantScope variant and its ops), `packages/guard/src/guard.ts` (`isUnsafeMatchPattern`, `resolvePointer`, the constrained branch of `scopeMatches`, mint-time validation at 1075-1097), core conformance cases, guard tests.
- [ ] Update tests: only `exact` and `tool` scopes exist; minting a constrained scope is a validation error
- [ ] Remove variant and matching machinery; amend `docs/contracts/05-guard.md` and `01-core.md`
- [ ] Full gate green; commit

### Task 6: Cut the scanner hook (A6)
**Files:** `packages/guard/src/guard.ts` (`#scanInput`/`#scanOutput`/`#reportScannerFinding`), `packages/guard/src/types.ts` (`Scanner`), `packages/vendo/src/index.ts` (re-export), tests.
- [ ] Update tests, remove hook and type, amend `docs/contracts/05-guard.md`
- [ ] Full gate green; commit

### Task 7: Cut age-based erase, open-enum, crypto legacy (A6, A7)
**Files:** `packages/store/src/erase.ts:260-310` (`byAge`), `packages/core/src/open-enum.ts` (delete; `errors.ts` and `triggers.ts` move to plain zod enums), `packages/store/src/crypto.ts` (v1 no-AAD decrypt branch, base64 canonicality round-trip → byte-length check), tests for all three.
- [ ] Update tests first (unknown enum variants now fail validation — intended), then cut
- [ ] Full gate green; commit

### Task 8: Cut catalog-ai and the dead lexer fallback (A6)
**Files:** `packages/actions/src/sync/catalog-ai.ts` (delete), `packages/actions/src/sync/index.ts` (`catalogCopyGenerator` knob + wiring), `packages/actions/src/index.ts` (exports), `packages/actions/src/sync/common.ts:211-303` (`fallbackModuleStatements` → lexer failure warns and skips the file), tests.
- [ ] Update tests, delete both, amend `docs/contracts/04-actions.md` if it names either
- [ ] Full gate green; commit

### Wave 1 checkpoint
- [ ] Report total lines removed vs the spec's estimates; open the wave-1 PR

## Wave 2 — structural shrinks (test-first, behavior-preserving)

### Task 9: Ephemeral overlay → disk rows (B3, store half)
**Files:** `packages/store/src/ephemeral.ts` (delete), dual branches in `packages/store/src/routing.ts:296-589`, tri-state path in `records.ts:79-352`, overlay mirror loops in `erase.ts`, `blobs.ts` overlay; new small sweep helper (anon-subject rows deleted past a TTL); store tests.
- [ ] Characterize current behavior in tests first (anonymous create/read/expire), then collapse to the single disk path + sweep
- [ ] Amend `docs/contracts/02-store.md` §4
- [ ] Full gate green; commit

### Task 10: Anonymous cookie → opaque pointer (B3, server half)
**Files:** `packages/vendo/src/server.ts:466-588` (HMAC sign/verify/constant-time-compare go; `__Host-` opaque random id stays), the anon→signed-in merge block at 709-740 (survives, simplified), tests.
- [ ] Tests first (anonymous session continuity, adoption on sign-in), then cut the signing
- [ ] Full gate green; commit

### Task 11: Wire handler → route table (B4)
**Files:** `packages/vendo/src/server.ts:602-1306` decomposed into a route-table module and per-area handler files (shape: one table of method+pattern+handler, one param/context extraction pass); `server.test.ts` and `wire-type-parity.test.ts` unchanged — they are the behavior lock.
- [ ] Migrate area by area (threads, apps, grants/approvals, connections, misc), running the wire tests after each
- [ ] Full gate green; commit per area

### Task 12: Approval internals onto store CAS (B5, guard half)
**Files:** `packages/guard/src/guard.ts` — `#consumeApprovedCall` (918-964) matches by approval id; `AsyncLock` (106-114) replaced by the store's `claim`/`atomic` primitives; tests keep the single-use-replay guarantee green.
- [ ] Tests first (double-consume rejected, resumption fires once), then swap the mechanism
- [ ] Full gate green; commit

### Task 13: Thread persistence single-path (B5, agent half)
**Files:** `packages/agent/src/threads.ts` — dual memory/store paths collapse to store-only (memory mode becomes the in-memory store adapter the package already has); the five-attempt merge loop becomes one CAS-guarded put; tests.
- [ ] Tests first (concurrent-append safety), then collapse
- [ ] Full gate green; commit

### Task 14: Duplication sweep, non-apps (B6)
**Files:** shared helpers for the cursor-drain loop (`agent/threads.ts:161`, `store` call sites) and `isRecord`; merge the two 16-entry layout-candidate lists in `packages/vendo/src/cli/theme/`; consolidate `humanize.ts` formatters; drop the `humanizeKey` alias.
- [ ] Pure refactor under existing tests; full gate green; commit

### Task 15: MCP consent page extraction (B7)
**Files:** `packages/mcp/src/oauth/server.ts:1023-1152` (consent HTML → template module), `vendoThemeStyle` de-duplicated against ui's mapping; tests.
- [ ] Pure extraction under existing tests; full gate green; commit

### Wave 2 checkpoint
- [ ] Full suite + a manual demo-bank smoke (`pnpm --filter demo-bank dev`: anonymous session, one approval flow) — B3/B5 touch live session/approval behavior
- [ ] Open the wave-2 PR

## Not in this plan (separate plans, after or parallel)
- **B1** extraction AST rewrite — own plan; corpus harness (`pnpm corpus`) is its quality gate.
- **B2** theme allowlist + LLM pass — own plan; depends on choosing the init-time model seam.
- **A1/A2/A3 + apps-side items** — format-gen-v2 merge point.
