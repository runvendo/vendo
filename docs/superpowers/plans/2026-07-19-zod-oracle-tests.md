# Zod Oracle Test Suite Implementation Plan (PR 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Differential-test the static zod reader (`zodFromExpression` in `packages/actions/src/sync/static-ts.ts`) against real zod + `zod-to-json-schema`, so every supported pattern has an automated answer key.

**Architecture:** One new table-driven test file in `@vendoai/actions`. Each row holds a zod expression as source text; the test interprets it statically (the mimic) and evaluates it for real (the oracle), comparing through a normalizer that removes representational — not semantic — differences. Rows are classified `match`, `divergent` (both sides pinned, with a written justification), or `permissive` (the mimic's intentional fail-closed fallback).

**Tech Stack:** vitest (existing), zod v3 (already a runtime dep), `zod-to-json-schema` (new devDependency, test-only).

**Spec:** `docs/superpowers/specs/2026-07-19-route-scan-inference-and-zod-oracle-design.md`

**Branch/PR:** work on the current `yousefh409/api-detect` branch; PR into `main` when green.

---

### Task 1: Workspace setup

**Files:** `packages/actions/package.json` (modify)

- [ ] Step 1: Run `pnpm install` at the repo root (this worktree's `node_modules` was removed in the July disk cleanup).
- [ ] Step 2: Add `zod-to-json-schema` as a devDependency of `@vendoai/actions` (`pnpm --filter @vendoai/actions add -D zod-to-json-schema`). devDependency only — it must not appear in `dependencies`.
- [ ] Step 3: Confirm the workspace still passes `pnpm lint` (the dependency guard must not object to a test-only dep).
- [ ] Step 4: Commit the dependency change alone.

### Task 2: Test harness

**Files:** `packages/actions/src/sync/static-ts.oracle.test.ts` (create)

- [ ] Step 1: Write the harness's static side: a helper that wraps a zod snippet in a one-declaration module (`const schema = <snippet>` with a zod import), parses it with the exported `parseModule`/`localInitializer`/`loadTypescript` utilities from `static-ts.ts`, and runs `zodFromExpression` on the declaration's initializer. No host repo needed — `loadTypescript` falls back to the workspace's own typescript devDependency.
- [ ] Step 2: Write the harness's oracle side: a helper that evaluates the same snippet with the real zod library (fixture text we authored — executing it is safe and intended here) and converts with `zod-to-json-schema` using `$refStrategy: "none"` and the string date strategy (matches the mimic's ISO-string convention for dates).
- [ ] Step 3: Write the normalizer with exactly these representational transforms, each commented: strip the `$schema` key; rewrite `type: [T, "null"]` arrays into the `anyOf` nullable form the mimic emits; drop a `type` that sits redundantly beside `const`. Nothing else — any other disagreement must surface as a failure.
- [ ] Step 4: Add one smoke row (a small `z.object` with a required and an optional property) and run the file (`pnpm --filter @vendoai/actions test -- static-ts.oracle`) to prove the harness plumbing works end to end. Fix plumbing until this row passes.
- [ ] Step 5: Commit the harness with the smoke row.

### Task 3: The pattern table — supported rows

**Files:** `packages/actions/src/sync/static-ts.oracle.test.ts` (modify)

- [ ] Step 1: Add one row per supported base constructor from `zodBase`: object (nested, with required/optional mix), string, number, bigint, boolean, date, null, any, unknown, literal (string and number), enum, array (typed and untyped), union, discriminatedUnion, record (typed and untyped value), and coerce variants.
- [ ] Step 2: Add one row per meaningful modifier from `applyZodModifier`, each inside an object so optionality shows up in `required`: optional, describe, nullish, nullable, default, min/max on string/number/array, int, email, uuid, url, datetime.
- [ ] Step 3: Run the suite. For each failing row, triage before touching anything: if the disagreement is semantic and the oracle is right, it is a mimic bug — fix `static-ts.ts` in its own commit with the row as the regression test; if the disagreement is representational, either extend the normalizer (only if principled and general) or reclassify the row as `divergent` with both sides pinned and a comment stating why our form is intentional (the known candidates: bigint's int64 format, `.catch()` implying a default).
- [ ] Step 4: Run the full actions suite (`pnpm --filter @vendoai/actions test`) to confirm any mimic fixes didn't break the extractor fixtures.
- [ ] Step 5: Commit the table (and any mimic fixes as separate, earlier commits).

### Task 4: The pattern table — fail-closed rows

**Files:** `packages/actions/src/sync/static-ts.oracle.test.ts` (modify)

- [ ] Step 1: Add `permissive` rows for the documented fail-closed cases: an unrecognized modifier (e.g. `.brand()`), an unrecognized constructor (e.g. `z.map(...)`), a non-literal enum, an unresolvable schema reference, and depth exhaustion. Each row asserts the mimic reported `recognized: false` with a reason — not schema equality.
- [ ] Step 2: Add rows for the passthrough modifiers the kill-list pinned (`trim`, `refine`, `transform`, `regex`, `positive`, `nonempty`, …) asserting the mimic passes the inner schema through; compare against the oracle where the oracle also passes through, classify `divergent` where it doesn't.
- [ ] Step 3: Run the suite; triage failures by the same rule as Task 3 Step 3.
- [ ] Step 4: Commit.

### Task 5: Ship

- [ ] Step 1: Run the repo gate: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` — all green.
- [ ] Step 2: Re-read the final table and confirm every entry in `zodBase`'s switch and `applyZodModifier`'s switch has at least one row (the suite is also the support catalog).
- [ ] Step 3: Push and open a PR titled "test: differential oracle suite for the static zod reader" describing the mimic/oracle/normalizer design, listing any mimic bugs found, and linking the spec.
- [ ] Step 4: Note in the PR that PR 2 (route-scan inference) builds on this suite per the spec.

---

## Decisions locked during planning

- The oracle evaluates fixture text we wrote ourselves — the never-execute rule applies to host code, not our own test fixtures.
- Normalizer transforms are a closed, commented list; growing it requires the same justification bar as reclassifying a row.
- Divergent rows pin **both** sides, so a future `zod-to-json-schema` upgrade that shifts oracle behavior is also caught.
- Mimic bugs found by the table are fixed in this PR (each with its row as the regression test) unless a fix would change extractor output for existing corpus expectations — that case gets reported in the PR and deferred to its own change.
