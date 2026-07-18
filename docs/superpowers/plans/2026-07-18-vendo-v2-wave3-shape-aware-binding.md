# Vendo v2 Wave 3 — shape-aware binding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the repo owner's global rules this plan is deliberately code-free: it locks decisions, files, behaviors, test cases, and commands; the executing engineer writes the code test-first.

**Goal:** Kill the broken-chart class: derive shape cards for host tool / fn: responses, give the wire a bounded reshape vocabulary, and make the compiler type-check every binding against the tool's response shape — mismatches become structured compile errors routed to per-binding repair; unknown shapes degrade to `Json` with defensive projection and a contained data-shape notice at render.

**Architecture:** Two new engine-facing modules in `@vendoai/core` (`shape.ts` — the shape model + shape cards; `reshape.ts` — the bounded reshape vocabulary with a runtime evaluator and a shape-flow checker), a pipe extension to the wire expression grammar, a post-compile shape-check pass in the wire compiler producing structured per-binding errors, and a minimal additive change to the ui renderer so a runtime reshape mismatch renders a contained notice instead of a broken component. The Wave 2 engine consumes only the exported core API (shape cards for model context, `toolShapes` compile option, `bindingErrors` repair contract); no `@vendoai/apps` internals are touched.

**Tech stack:** TypeScript, zod (types+zod pairing convention), vitest; React only for the small renderer change.

**Design authority:** `docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md` §3 + Wave 3. Do not re-litigate.

---

## Locked design decisions

### D1. Shape model (`packages/core/src/shape.ts`)
- `ShapeType` — a small, Json-serializable structural type language: `string` / `number` / `boolean` / `null` scalars, `json` (unknown — the defensive default), `array` (with `items`), `object` (with `fields` map and an `optional` field-name list). Values are never stored — only structure ("values hashed away").
- `deriveShape(sample)` — derive a `ShapeType` from one recorded sample Json value. Array element shapes merge across elements; an empty array's items are `json`.
- `mergeShapes(a, b)` — union for multi-sample derivation: object∪object merges fields (fields missing on one side become optional), array∪array merges items, identical scalars keep their kind, any other combination degrades to `json`.
- `shapeAtPointer(shape, pointer)` — walk a ShapeType by RFC 6901 JSON Pointer segments; `undefined` past scalars/absent fields; `json` stays `json` at any depth. Array index segments step into `items`.
- `ShapeCard` — `{ tool, output: ShapeType, source: "sample" | "declared", sampledAt? }` + zod schema. `deriveShapeCard(tool, samples[])` builds one from recorded samples (this is the "at `vendo sync` or from a recorded sample" seam — the CLI/engine records samples and calls this; no CLI changes in this wave).
- `describeShape(shape)` — compact human/model-readable notation (e.g. `{ month: string, revenue: number }[]`) the engine embeds in the model's tool context. Deterministic, bounded depth.

### D2. Reshape vocabulary (`packages/core/src/reshape.ts`)
Closed, pure, non-Turing op registry — exactly the spec's five families:
- `pick(field, ...)` — keep fields; on an object or per-row on an array of objects.
- `rename(old, new, ...)` — pairwise field rename; object or per-row.
- `asPoints(labelField, valueField)` — the map op and the chart fix: array of objects → array of `{ label, value }` rows.
- `format(field, kind)` / `format(kind)` — per-row field formatting or scalar formatting; kinds `number` / `currency` / `percent` / `date`; deterministic en-US/USD Intl output.
- Aggregates — `sum(field)` / `avg(field)` / `min(field)` / `max(field)` over an array of objects → number; `count()` → array length.

Canonical form: `PathBinding` gains an optional `$reshape: ReshapeStep[]` (`{ op, args: string[] }`) — additive, so `isPathBinding` and every existing consumer keep working. Also legal on `$state` bindings' values at runtime (no shape check — state has no card).

Three exported operations over steps:
- `findInvalidReshape(props)` — deep-walk validation used by `validateTreeV2` (unknown op, bad arity, non-string args ⇒ the tree fails provision — the bounded vocabulary is enforceable at the gate, not just at compile).
- `applyReshape(value, steps)` — the total runtime evaluator: `undefined` in ⇒ ok/`undefined` out (query still loading is not a mismatch); a runtime type mismatch ⇒ `{ ok: false, reason }`, never a throw.
- `reshapeShape(shape, step)` — the shape-flow checker the compiler uses: `json` in ⇒ `json` out with no error (defensive); a known-shape mismatch (missing field, wrong container kind) ⇒ a typed error naming the missing/expected pieces.

### D3. Wire grammar extension (`packages/core/src/wire-v2/expression.ts`)
- A pipe chain is legal after a reference in any value position (top-level and nested — the wave-1 "top level only" hack is removed along with its `reshape-unsupported` issue code, which was documented as wave-3's to replace).
- Pipe segments are `op(arg, ...)` with bare-identifier or quoted-string args. Parse-level violations (unknown op, wrong arity, non-string arg, malformed call) drop the attribute with a new `invalid-reshape` issue — same discipline as every other grammar failure.
- A clean parse compiles to `$reshape` steps on the binding. Pipes are legal on `state.x` references too.

### D4. Compile-time shape check (`packages/core/src/wire-v2/shape-check.ts`)
- `WireCompileOptions` gains `toolShapes?: Record<string, ShapeType>` (keyed by the query's `tool` string, host tools and `fn:` refs alike — the engine builds this from its shape cards).
- After the parse, a post-pass walks every emitted node's props for path bindings: query name → hoisted tool → shape card. It checks the `$path` suffix via `shapeAtPointer` and flows the shape through each `$reshape` step via `reshapeShape`.
- A binding into fields absent from a KNOWN shape ⇒ a `shape-mismatch` issue AND a structured entry in the new `WireCompileResult.bindingErrors: BindingShapeError[]` — `{ nodeId, prop, query, tool, pointer, message, available? }` — the per-binding repair contract. The binding stays in the tree (repair needs the anchor); shipping is the engine's gate: `bindingErrors.length > 0` = unshippable.
- No card for the tool, or a `json` region ⇒ `Json` type, no error, runtime defense takes over (D5). `state` bindings and bindings to undeclared names (already dropped in wave 1) are skipped.
- `complete` stays structural (parse-only); shape errors never clear it.

### D5. Runtime containment (`packages/ui/src/tree/renderer.tsx`)
- Where the walk resolves a `$path`/`$state` binding, a binding carrying `$reshape` runs `applyReshape` on the resolved value.
- A `{ ok: false }` result marks the prop; the node renders the existing `ContainedNotice` chrome with a "Data shape" label (naming the prop and reason) INSTEAD of mounting the component with garbage props — the spec's contained data-shape notice. Loading/absent data (`undefined`) is not a mismatch and renders exactly as today.
- The change is additive: a small bound-props helper wrapping the three existing `bindValue` call sites; no jail/guard/action changes. The v2→v1 payload conversion passes `$reshape` through untouched (props are copied structurally).

### D6. Public API (the Wave 2 interface — core root exports only)
From `@vendoai/core`: `ShapeType`, `deriveShape`, `mergeShapes`, `shapeAtPointer`, `describeShape`, `ShapeCard` (+schema), `deriveShapeCard`; `RESHAPE_OPS`, `ReshapeStep`, `applyReshape`; `BindingShapeError`; the extended `WireCompileOptions` / `WireCompileResult`. The engine passes shape descriptions into the model prompt with `describeShape`, passes `toolShapes` into `compileWireV2`, and drives repair from `bindingErrors`. Nothing in `@vendoai/apps` is edited in this wave.

---

## Tasks (TDD; commit after each)

### Task 1 — Shape model
Create `packages/core/src/shape.ts` + `shape.test.ts`. Tests first: derive from scalar/object/nested/array samples; empty array ⇒ `json` items; multi-sample merge (optional fields, kind conflicts ⇒ `json`); `shapeAtPointer` hits, misses, `json` passthrough, array index; `describeShape` notation incl. depth bound; `ShapeCard` schema accept/reject; `deriveShapeCard` over multiple samples.

### Task 2 — Reshape vocabulary
Create `packages/core/src/reshape.ts` + `reshape.test.ts`. Tests first, per op family: `applyReshape` happy paths, undefined passthrough, runtime mismatches (`ok: false`, no throw); `reshapeShape` flow per op incl. `json` defensiveness and typed errors; `findInvalidReshape` deep walk (unknown op / arity / arg kinds / non-array steps).

### Task 3 — Canonical form + gate
Modify `packages/core/src/tree.ts` (`PathBinding.$reshape?`) and `packages/core/src/tree-v2.ts` (`validateTreeV2` walks props via `findInvalidReshape`). Tests in `tree-v2.test.ts`: a valid `$reshape` passes; unknown op / bad steps fail provision; v1 `validateTree` untouched.

### Task 4 — Wire pipe grammar
Modify `packages/core/src/wire-v2/expression.ts` (+ `expression.test.ts`): pipes compile to `$reshape` (top-level, nested, chained, on `state.x`); `invalid-reshape` drops the attribute; `reshape-unsupported` code removed from the registry and its wave-1 tests replaced.

### Task 5 — Compile-time shape check
Create `packages/core/src/wire-v2/shape-check.ts`; modify `compile.ts` (option, post-pass, `bindingErrors`). Tests in `compile.test.ts`: the spec's chart-bug class — a `LineChart` bound to a field absent from the tool's shape — produces `shape-mismatch` + a structured `bindingError` with the node/prop/tool anchor and available fields; reshape flows checked step-by-step; unknown tool ⇒ no error; no `toolShapes` ⇒ wave-2-compatible behavior; valid-while-partial and determinism properties still hold (roundtrip e2e untouched/extended).

### Task 6 — Exports
Modify `packages/core/src/index.ts`. Keep wire-v2 internals internal; export the D6 surface. Run the core type-surface/contract tests.

### Task 7 — Renderer containment
Modify `packages/ui/src/tree/renderer.tsx` (+ tree tests beside the existing renderer tests): `$reshape` applied on resolution; mismatch renders the contained "Data shape" notice; loading/absent data unchanged; jail path unchanged. Browser-verify: drive a small v2 payload with a reshape binding through the real renderer in a browser, screenshot both the happy chart and the contained notice for the PR.

### Task 8 — Docs + gates + PR
Sync `docs/` (the v2 format/shape section referenced from the spec — additive page or section on shape cards + reshape vocabulary + repair contract). `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green. PR "v2 format Wave 3: shape-aware binding" to main; triage AI reviewers; squash-merge when green.
