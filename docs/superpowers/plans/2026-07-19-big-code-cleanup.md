# Big Code Cleanup — vendo + vendo-web

> **For agentic workers:** Discovery-driven campaign executed via dynamic Workflows
> (user-approved). Work-lists come from discovery workflows, not from this file.

**Goal:** Make both repos dead-code-free, extremely readable, and bug-free in the
product code, landing as one PR per repo with the full green gate.

**Decisions (locked with Yousef 2026-07-19 — don't re-ask):**
- Deliverable: apply everything, including bug fixes (each fix gets a test).
- Scope: product code + docs.
  - vendo (flowlet): `packages/` + `docs/`. Skip `apps/` demos, `corpus/`,
    `docs-site/` (except where docs describe changed code).
  - vendo-web: `app/`, `components/`, `lib/`, `services/`, `workers/`,
    `console-shell/`, `ui-funnel-selfserve/` + docs. Skip `vendor/`, `out/`,
    `playground-deploy/`, and the untracked in-flight `cloud-backend/`.
- Aggression: aggressive — module restructuring and wholesale rewrites allowed
  where they clearly win; behavior must be preserved (tests + browser evidence).
- PR shape: one PR per repo.

**Constraints:**
- Never commit to main; vendo work on `yousefh409/code-cleanup` (this worktree),
  vendo-web on a fresh branch off `main` (its checkout currently sits on the
  in-flight `agent-dx-root` branch — leave that branch and its untracked dirs alone).
- Gate before PR: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- UI-affecting changes verified in a real browser with screenshots in the PR.
- vendo layering enforced by `scripts/dependency-guard.mjs` — restructuring must
  respect it.
- Public API of published `@vendoai/*` packages must not change silently; if an
  export is dead *externally* it can go, but flag any removal that touches the
  documented integration surface.
- Bug fixes follow TDD: failing test first, then the fix.

## Phases (run vendo first, then vendo-web)

### Phase 0 — Baseline (per repo)
Confirm the gate is green on the branch before any edits, so failures later are
ours. Record baseline test counts.

### Phase 1 — Discovery workflow (per repo)
One dynamic workflow, three parallel finder families over the scoped dirs:
1. Dead code: tool-assisted (knip/ts-prune/depcheck where configured, plus
   grep-verified unused exports, orphaned files, stale flags, unused deps).
2. Readability/simplicity: per-package auditors hunting needless indirection,
   duplicated logic, over-abstraction, dead options, convoluted control flow —
   with aggressive restructure proposals where clearly better.
3. Bugs: multi-lens hunters (correctness, async/races, error handling silent
   failures, unit/cents seams, security).
Every finding is adversarially verified by an independent skeptic before it
enters the work-list. Output: deduped, confirmed, per-area work-list.

### Phase 2 — Apply workflow (per repo)
Pipeline over work-list items grouped by package/area so writers never touch the
same files concurrently. Bug fixes: test-first. Checkpoint the gate after each
area group; revert an area if it can't be made green.

### Phase 3 — Verify & evidence
Full gate. Browser verification with screenshots for anything UI-affecting
(vendo: playground/demo-bank rendering of packages/ui; vendo-web: the live site
pages). Fresh review pass (code-review workflow) over the final diff; fix what
it confirms.

### Phase 4 — Docs sync + PR
Sync `docs/` (and vendo-web docs) with removals/renames — including the stale
`docs/contracts/` reference in vendo's CLAUDE.md. Open one PR per repo with
evidence; report any deferred/ambiguous findings in the PR description.
