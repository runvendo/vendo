# B1: Extraction on the TypeScript AST — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill-list item B1 (`docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §B1): the extraction pipeline keeps its exact behavior and coverage but every hand-rolled TypeScript parser in `packages/actions/src/sync/` — the route-scan verb regexes, the brace-walker toolkit in `common.ts`, and the pins `StaticValueParser` — is rewritten on the TypeScript compiler API the package already uses for tRPC, server actions, and catalog scanning. The zod→JSON-Schema interpreter's passthrough-modifier allowlist narrows to measured usage. Filenames, exports, and the public API do not change.

**Behavior lock:** the existing `@vendoai/actions` test suite plus the corpus harness. A full `pnpm corpus run --layer 2` baseline is captured at the base commit (in a space-free clone — the harness rejects paths with spaces) before any change; the same sweep re-runs on the finished branch and must be equal-or-better per repo.

**Why the module-lexer moves too:** simplify-v2 proved `fallbackModuleStatements` is the live TSX parser behind `resolveImportSource`/`importReferenceFor` (es-module-lexer throws on JSX). Its consumers are not just route-scan and pins — every extractor resolves imports through it. The only way it "loses all its consumers" (spec §A6-corrected / §B1) is to move the module-statement reading itself onto the TypeScript AST, which also retires the `es-module-lexer` dependency.

**Per-task ritual:** tests first (add coverage locks against the current implementation where the exotic paths are untested, watch them pass, then swap internals), `pnpm --filter @vendoai/actions test` green, one commit.

---

## Task 0: Corpus baseline
- [x] Clone the worktree at the base commit into a space-free scratch path, `pnpm install && pnpm build`, run `pnpm corpus run --layer 2 --json`, save the scorecard (runs in background alongside Tasks 1-4)

## Task 1: Module analysis in common.ts onto the TS AST
**Files:** `packages/actions/src/sync/common.ts` (module lexing internals), `packages/actions/package.json` (drop `es-module-lexer`).
- [ ] Add behavior-lock tests for import/re-export resolution shapes only exercised implicitly today (namespace member references, export-star chains, semicolon-free TSX) — green against the current implementation
- [ ] Replace the es-module-lexer + `fallbackModuleStatements` path inside the module reader with TypeScript-AST statement walks (host-first compiler loading, same fail-closed posture as `static-ts.ts`)
- [ ] Delete `fallbackModuleStatements`; grep-verify no consumer remains; drop the `es-module-lexer` dependency
- [ ] Actions suite green; commit

## Task 2: route-scan.ts onto the TS AST
**Files:** `packages/actions/src/sync/route-scan.ts`.
- [ ] Add a route-scan behavior-lock test file covering the currently untested evidence paths: destructured verb exports, `export { x as GET }`, verb-keyed `defaultHandler` objects, `"VERB /path"` route maps, `setHeader("Allow", ...)` lists, `NextAuth()` pages, re-export/delegate chains, and the pages-inference heuristics — green against the current implementation
- [ ] Rewrite verb evidence gathering (exported verbs, route maps, method-key objects, re-export targets, page inference) as AST queries over the parsed route module; file-path→URL mapping (`cleanSegment`/`routePath`) stays — those regexes match path segments, not code
- [ ] Remove the now-dead statement/brace helpers from route-scan and the `splitTopLevel`/`stripComments`/`topLevelObjectLiteral` imports
- [ ] Actions suite green; commit

## Task 3: pins.ts onto the TS AST
**Files:** `packages/actions/src/sync/pins.ts`, then dead-helper cleanup in `common.ts`.
- [ ] Registration discovery (`{ name, component }` object literals, `remixable(` helper marking, router-table `path` exclusion, literal offsets) becomes an AST walk
- [ ] `StaticValueParser` is replaced by static AST evaluation of the sampleProps initializer with the same JSON-compatible acceptance rules (same invalid-sampleProps warnings)
- [ ] `importSpecifiers` (static, re-export, dynamic import; type-only skipped) becomes an AST walk
- [ ] Delete `splitTopLevel`, `topLevelObjectLiteral`, and `stripComments` from common.ts once grep shows zero consumers; tsconfig JSONC parsing moves to the compiler API's config-text parser
- [ ] Actions suite green; commit

## Task 4: Narrow the zod passthrough allowlist
**Files:** `packages/actions/src/sync/static-ts.ts`.
- [ ] Measure: grep the corpus checkouts (from the Task 0 clone) and the actions test suite for zod modifier methods actually chained in extracted input schemas
- [ ] Shrink `ZOD_PASSTHROUGH_MODIFIERS` to that measured set; unlisted modifiers keep failing closed (permissive schema + note); adjust any test that asserted passthrough of a removed modifier to assert the fail-closed result instead
- [ ] Actions suite green; commit

## Task 5: Contract amendment
**Files:** `docs/contracts/04-actions.md`.
- [ ] Amend §1 prose: route-scan and pin capture are now compiler-API static analysis like tRPC/GraphQL/server-actions; dated changelog entry, authorized-by kill-list §B1
- [ ] Commit

## Task 6: Verification and PR
- [ ] Re-run `pnpm corpus run --layer 2 --json` on the finished branch in the same clone; per-repo scores equal-or-better than the Task 0 baseline; fix any regression before proceeding
- [ ] `pnpm build && pnpm exec turbo run test --concurrency=4 && pnpm typecheck && pnpm lint` green (actions fixture.e2e re-run once if sole failure)
- [ ] Push branch, open PR "B1: extraction on the TypeScript AST (kill-list B1)" with before/after line counts, the corpus baseline-vs-after table, and the deletion inventory; do not merge
