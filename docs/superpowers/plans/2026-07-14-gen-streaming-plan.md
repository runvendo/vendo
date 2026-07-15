# gen-streaming — streamed generation + latency gates (ENG-240, ENG-245)

**Parent spec:** `docs/superpowers/specs/2026-07-14-ui-generation-design.md` (ui-generation worktree, approved by Yousef 2026-07-14 — all decisions locked).
**Goal:** p95 first meaningful paint of generated UI < 1s after the generation tool call; usable view < 10s; no quality sacrifice. Baseline to beat: first pixel 63–103s, total 90–145s, plus a 15–30s blocking approval card.
**Execution:** codex sol workers in separate Orca worktrees, one PR per task, coordinated by this session.

## Where the time goes today

1. Blocking approval card before `vendo_apps_create` even runs (15–30s of human wait).
2. `engine.create` buffers the whole model response (`generateText`), so nothing paints until the full tree is generated and validated.
3. `open()` resolves tree queries sequentially after the full tree exists.
4. `vendo_apps_edit` failures force a full ~92s rebuild plus a second approval (ENG-245).

## Architecture decisions (made here, within the locked spec)

- Partial trees ride the **existing** `data-vendo-view` SSE part using ai-SDK data-part id reconciliation (same part id, updated payload), rather than a new delta part type. The chrome-side consumer re-renders on part update, so `packages/ui/src/chrome/*` (block-ui's zone) should need no changes. If a chrome edit turns out to be required, coordinate through the parent first.
- The renderer already skeletons dangling child ids; the streaming work stays in `tree/*` (our zone) if `validateTree` needs a partial-tree accommodation.
- Approval reclassification is provably safe for tree paths: create is rung-1 by contract; the tree-edit dialect can only return rung-1 documents. Server-instruction edits keep the approval card.
- Stream + slim with the strong model first, re-measure, tiering only if still short (locked decision 8).

## Waves

### Wave 1 — three parallel workers

1. **streaming-engine** (core of ENG-240): engine `generateText` → `streamText` with incremental tree parsing; stream partial trees through runtime create/open to the tool bridge; emit id-reconciled partial view parts; parallelize `open()` query resolution and resolve queries as they stream in; progressive paint verified in a real browser on demo-bank.
2. **edit-reliability** (ENG-245): root-cause the blank-iframe edit failure; harden the tree-ops fast path; regression tests; browser-verified remix on demo-bank.
3. **auto-approve** (ENG-240 approvals): rung-1 UI creates and tree edits become read-class (no card); approvals stay for server rungs and external writes; guard/policy tests.

### Wave 2 — after wave 1 merges, two parallel workers

4. **slim-contract**: leaner generation prompt and smaller trees (primitives/catalog preferred over generated jailed code); must not restructure the catalog prompt section (gen-catalog's zone) or theme slots (gen-fidelity's zone).
5. **spans-bench**: runtime timing spans (agent turn → engine TTFB → tree complete → queries → paint); CI bench gates on p95 first-paint < 1s and usable < 10s; a remix bench; extend the existing root `bench/` harness.

### Wave 3 — orchestrator verification

6. Live re-measure on Maple + Cadence against the 2026-07-14 baseline; streaming first-paint GIF with visible timer; report numbers to the parent; invoke the tiering fallback only if gates are still short.

## Quality bar (every PR)

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- UI-affecting changes verified in a real browser with screenshots/GIFs in the PR.
- Never commit to main; branch + PR.

## File zones

We own `packages/apps` engine/runtime/open streaming paths, `packages/agent` tool-bridge streaming path, and `packages/ui/src/tree/*` renderer streaming path. Do not touch `packages/ui/src/chrome/*` (block-ui), `theme.ts`/primitives/jail (gen-fidelity), or the catalog config/prompt-catalog section (gen-catalog) without parent coordination.
