# Vendo v2 Wave 1 — format + compiler + renderer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the repo owner's global rules this plan is deliberately code-free: it locks decisions, files, behaviors, test cases, and commands; the executing engineer writes the code test-first.

**Goal:** Ship the `vendo-genui/v2` canonical tree format in `@vendoai/core`, the JSX-like wire grammar with a deterministic wire→tree compiler, and the v2 renderer in `@vendoai/ui` — registered behind the existing `formatVersion` dispatch with v1 fully coexisting.

**Architecture:** Three formats, one compiler (spec §1). The model emits JSX-like markup (wire); a deterministic, total, pure compiler in core parses it into the canonical v2 tree (minting all node ids); the ui renderer renders that canonical tree by reusing the v1 render path (registry dispatch, binding resolution, jail, action chokepoint all unchanged). Apps' open path learns to resolve v2 queries; everything else passes through the existing seams.

**Tech stack:** TypeScript, zod (core's only dependency — the compiler is hand-written, no parser libraries), React + the existing `@vendoai/ui` tree renderer, vitest.

**Design authority:** `docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md`. Do not re-litigate format or pipeline choices.

---

## Locked design decisions (resolved against the current codebase)

These are the decisions the spec leaves to implementation, settled here after reading the v1 machinery. Executors follow them; do not re-decide.

### D1. Canonical v2 tree shape
`TreeV2` mirrors the v1 `Tree` structurally: `formatVersion` (the new constant `"vendo-genui/v2"`), `root` (node id), `nodes` (the existing v1 `TreeNode` shape reused verbatim — id, component, source, props, children), optional `data`, optional `queries`. Two differences from v1:
- Queries are **named**: a v2 query carries `name` + `tool` + optional `input` (no `path` field). The query's result lives in the data model at the JSON-Pointer `/` + name, by definition. Query names match the same identifier grammar as fn: names (letter/underscore start, then word chars), must be unique, and must not collide with the reserved data key `state`.
- Generated-component sources live **at the app-document level at rest**, exactly like v1 (the wire carries them; the document lifts them). The compile result returns them separately from the tree.

`PathBinding` / `StateBinding` are reused unchanged. No new binding kinds in wave 1 (the reshape vocabulary is wave 3).

### D2. Format constant and dispatch
- New constant `VENDO_TREE_FORMAT_V2 = "vendo-genui/v2"` beside `VENDO_TREE_FORMAT` in `packages/core/src/formats.ts`.
- `validateTreeV2` is the normative v2 validator (same result contract as `validateTree`: ok/tree or version/provision error), enforcing the same pinned §8 limits (`TREE_MAX_NODES`, `TREE_MAX_QUERIES`, node-id uniqueness, root integrity, fn: grammar anywhere a callable is named, generated-component presence).
- `validateAppDocument` gains a v2 branch exactly mirroring the v1 branch: a v2 tree in a document must NOT carry a `components` member (they live at document level); the branch grafts document components on for tree validation and collects fn: references from v2 queries and node props into the existing machine-presence check. The format-drill tests must keep passing untouched — unknown tags stay opaque.

### D3. Wire grammar (wave-1 subset, prose-normative)
The wire is a single `App` element. Grammar rules:
- **Elements:** `App` (document wrapper, required root), `Query` (data declaration), `Island` (generated component source), and component elements (PascalCase names). Self-closing and open/close forms. Unknown lowercase/invalid tags are a compile issue; the element is skipped.
- **App:** its `name` attribute is the app/document name (returned beside the tree, not stored in it). The App's non-Query, non-Island children become children of a synthetic root node with id `root`, component `Stack` (the neutral v1 layout primitive).
- **Query:** `id` attribute = the query name (matches the spec's example `Query id="revenue"`); `tool` attribute = tool name or fn: reference; optional `input` expression attribute. Queries are hoisted to the tree's `queries` list in document order wherever they appear; a nested Query produces a non-fatal issue.
- **Island:** `name` attribute (PascalCase, non-reserved); its raw text content up to the literal closing tag is the TSX source — no escaping, no nested parsing. Island names become generated components; nodes using an island name get `source: "generated"`.
- **Component elements:** compile to `TreeNode`s. Resolution order per spec §2 (host catalog → prewired primitives → islands, host wins): the compiler accepts an optional list of host component names; a node's `source` is `host` if the name is in that list, else `prewired` if it is one of the prewired names (the 7 reserved layout primitives + the 8 branded prewired components), else `generated` if an island of that name exists, else undefined (renderer shows its contained unknown-component notice).
- **Attributes:** string form (double-quoted, backslash escapes for quote and backslash), expression form (balanced-brace, parsed by the expression grammar below), and bare boolean form (attribute name alone = true).
- **Text children:** bare text inside a component element compiles to a child `Text` node carrying the text as its prop. Whitespace-only text is ignored.
- **Ids:** the compiler mints ALL node ids deterministically: lowercase component name + `-` + per-component-name ordinal in document order (first LineChart = `linechart-1`, second = `linechart-2`); the synthetic root is `root`. Identical wire input always yields identical ids. Wire-supplied `id` attributes on component elements are ignored with a non-fatal issue (ids are compiler-owned; `id` on Query is the query name, not a node id).

### D4. Expression grammar (attribute values in braces)
A JSON5-lite value language, hand-parsed:
- Literals: numbers, double- or single-quoted strings, true/false/null.
- Arrays and objects (object keys: bare identifiers or quoted strings; trailing commas tolerated).
- **Bindings:** a bare dotted identifier path in value position. Resolution: first segment `state` → a `$state` binding on the second segment (deeper nesting after `state.x` is a compile issue in wave 1); first segment matching a declared query name → a `$path` binding on `/` + segments joined; anything else → a compile issue naming the unknown reference (the attribute is dropped). Bindings are legal at top level and nested inside arrays/objects.
- **Reshape pipes** (`value | fn(args)`): the grammar recognizes and consumes the pipe syntax, compiles the base binding, and records a non-fatal issue that the reshape vocabulary lands in wave 3. Nothing breaks; the raw binding renders.

### D5. Actions
An attribute whose name starts `on` + uppercase letter and whose value is a string naming a tool (matches the core tool-name pattern) or an fn: reference compiles to the v1 canonical action prop shape — an object with an `action` member — dispatched through the existing chokepoint. Invalid fn: syntax is a compile issue. Expression-form attributes that already contain an object with an `action` member pass through untouched.

### D6. Deterministic, total, valid-while-partial compile
`compileWireV2` (pure function in core, no I/O) accepts the wire text plus options (currently: known host component names) and returns the canonical tree, the generated-components map, the document name if present, an ordered list of issues (each with a stable code and message), and a `complete` boolean. It never throws on any input:
- A truncated stream compiles to a valid smaller tree: unterminated open elements are auto-closed at EOF; an incomplete trailing tag, attribute, or expression is dropped; an unterminated Island or Query is dropped; `complete` is false.
- The §8 caps are enforced at compile: node/query/component/byte overflows stop further accumulation and produce issues (the emitted tree stays within limits and valid).
- The compiled tree must always pass `validateTreeV2` — property-tested across every fixture and truncation point in the test suite (compile(prefix) is valid for every prefix length of every fixture).

### D7. v2 renderer reuses the v1 walk
A new renderer module in `packages/ui/src/tree/` validates the payload with `validateTreeV2`, adapts the canonical v2 tree to the v1 renderer's input shape (formatVersion swap + named queries mapped to path-keyed queries at `/` + name — a pure, total mapping), and mounts the existing stateful tree walk. It registers itself under `"vendo-genui/v2"` via the existing `registerTreeRenderer` seam at module scope and is exported from the tree entry point so registration always accompanies the renderer. Jail, bindings, action dispatch, containment, skeletons: all inherited.

One scoped shared-path change: when a node's `source` is explicitly `host`, the host implementation must win over a prewired primitive of the same name (spec §2 "host brand wins"; today the walk prefers the primitive unconditionally). Undefined-source and v1 behavior stay as-is (primitive first).

### D8. Apps open path resolves v2 queries
`packages/apps/src/open.ts` currently passes any non-v1 payload through byte-identical with no query resolution. Wave 1 adds a v2 branch: validate, map named queries to the progressive query resolver (results written at `/` + name), reuse the existing forged-server-field stripping, and emit the v2 payload with live data — so an opened v2 app renders with real query results. Unknown/other tags keep the existing passthrough.

### D9. Contracts
Contracts are unfrozen for v2. Amend in place with dated amendment notes: `docs/archive/contracts/01-core.md` §8 (the v2 format: canonical shape, named queries, compiler ownership of ids, wire grammar existence + valid-while-partial, same limits) and `docs/archive/contracts/08-ui.md` §5 (v2 renderer registration beside v1, host-wins-on-explicit-host-source). Also note the wire compiler as a core export in 01-core's utility surface.

### D10. What wave 1 does NOT include
No engine changes (`modelEngine` still emits v1 — wave 2). No reshape evaluation, no shape cards (wave 3). No edit dialect, no v1→v2 transpile, no retrieval cache (wave 4). No new stream parts. The incremental v1 streaming parser in apps is untouched.

---

## File map

**Create:**
- `packages/core/src/tree-v2.ts` — TreeV2 types + zod schemas + `validateTreeV2` (reuses tree-limits, component-map, fn-references, `isPlainObject`).
- `packages/core/src/wire-v2/expression.ts` — the expression-grammar parser (values, bindings, pipes), exported for the compiler and its tests; internal to the package root except through the compile result.
- `packages/core/src/wire-v2/compile.ts` — tokenizer + element parser + `compileWireV2` (ids, hoisting, islands, actions, limits, partial semantics).
- `packages/core/src/tree-v2.test.ts`, `packages/core/src/wire-v2/expression.test.ts`, `packages/core/src/wire-v2/compile.test.ts` — core TDD suites.
- `packages/ui/src/tree/renderer-v2.tsx` — validate + adapt + mount the v1 walk; module-scope registration.
- `packages/ui/test/tree/renderer-v2.test.tsx` — render tests (follows the existing `tree-view.test.tsx` / `format-drill.test.tsx` patterns).
- `packages/core/src/wire-v2/roundtrip.e2e.test.ts` — the wave gate: hand-written wire fixture → compile → validate → (in ui's suite) render.

**Modify:**
- `packages/core/src/formats.ts` — add `VENDO_TREE_FORMAT_V2`.
- `packages/core/src/app-document.ts` — v2 branch beside the v1 branch.
- `packages/core/src/index.ts` — export the new surface (constant, types, `validateTreeV2`, `compileWireV2` + its result types).
- `packages/ui/src/tree/index.ts` — export the v2 renderer module.
- `packages/ui/src/tree/renderer.tsx` — the scoped host-wins-on-explicit-source change only.
- `packages/apps/src/open.ts` — the v2 query-resolution branch.
- `packages/apps/src/open` tests (wherever the existing open/format-drill coverage lives) — v2 open coverage.
- `docs/archive/contracts/01-core.md`, `docs/archive/contracts/08-ui.md` — amendments.

Layering stays legal: core imports nothing new; ui imports core only; apps imports core. `scripts/dependency-guard.mjs` (via `pnpm lint`) must stay green.

---

## Tasks

### Task 1: v2 format constant, canonical tree types, `validateTreeV2`

**Files:** create `packages/core/src/tree-v2.ts` + `packages/core/src/tree-v2.test.ts`; modify `packages/core/src/formats.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1 — failing tests.** Write `tree-v2.test.ts` covering: a minimal valid v2 tree validates ok; wrong/absent formatVersion fails with code `version` (v1 tag included); root must name an existing node; duplicate node ids fail; node caps (`TREE_MAX_NODES` + 1) fail; query caps fail; query name grammar (rejects empty, leading digit, spaces, duplicates, the reserved name `state`); query tool must be non-empty and fn: refs must match the fn grammar; a tree-level `components` member is rejected (documents own components — mirror of the v1 lift rule, but stricter: v2 never carries them in the tree); action fn: grammar enforced anywhere in props; a `generated`-source node without a matching document-level component is checked at the document layer, not here (assert validateTreeV2 accepts it — the presence rule needs the document).
- [ ] **Step 2 — run to verify failure.** `pnpm --filter @vendoai/core test -- tree-v2` — expect module-not-found/failures.
- [ ] **Step 3 — implement.** Add the constant to `formats.ts`; write `tree-v2.ts` per D1/D2 following `tree.ts`'s structure and error-result contract exactly (same code values `version`/`provision`, same try/catch totality wrapper, zod schemas as structural documentation beside the normative validator). Export from `index.ts` mirroring how v1 tree exports are surfaced.
- [ ] **Step 4 — run to verify pass.** Same command; all green. Also `pnpm --filter @vendoai/core test` to prove no v1 regression (format-drill untouched).
- [ ] **Step 5 — commit.** `git add -A && git commit` — message: feat(core): vendo-genui/v2 canonical tree + validator.

### Task 2: expression parser

**Files:** create `packages/core/src/wire-v2/expression.ts` + `expression.test.ts`.

- [ ] **Step 1 — failing tests.** Cases: numbers (int, float, negative), both quote styles with escapes, true/false/null; arrays incl. nested + trailing comma; objects with bare and quoted keys; bare identifier resolving to a `$path` binding when it names a declared query (the parser takes the declared-names context as input); dotted path → pointer with segments; `state.x` → `$state`; unknown identifier → issue + dropped value marker; bindings nested inside arrays/objects; pipe syntax consumed with base binding compiled + wave-3 issue recorded; malformed input (unterminated string, unbalanced bracket) → issue, no throw; every case asserts no exception escapes.
- [ ] **Step 2 — run to verify failure.**
- [ ] **Step 3 — implement** per D4: a single-pass recursive-descent parser over the brace-slice, returning value-or-dropped + ordered issues. Pure, no regex backtracking hazards, character-cursor style consistent with core's existing hand parsers (see `incremental-tree.ts` in apps for the house style of cursor helpers).
- [ ] **Step 4 — run to verify pass.**
- [ ] **Step 5 — commit.** feat(core): v2 wire expression grammar.

### Task 3: wire markup parser + compiler skeleton (elements, attributes, id minting)

**Files:** create `packages/core/src/wire-v2/compile.ts` + `compile.test.ts`.

- [ ] **Step 1 — failing tests.** Cases: the spec §2 example (minus reshape pipes) compiles to a tree that passes `validateTreeV2`; deterministic ids (`root`, `pageheader-1`, `grid-1`, `linechart-1`, …) and byte-identical output on recompile; nesting → children arrays in order; self-closing and paired tags; string/expression/bare-boolean attributes land in props; unknown tag skipped with issue; stray close tag issue; wire-supplied component `id` attribute ignored with issue; App `name` returned as document name; no-App-root input → empty-ish valid tree (root Stack, zero children) + fatal-ish issue recorded, still no throw.
- [ ] **Step 2 — run to verify failure.**
- [ ] **Step 3 — implement** the tokenizer + element stack per D3/D6, using Task 2's expression parser for brace attributes. Compile result shape per D6.
- [ ] **Step 4 — run to verify pass.**
- [ ] **Step 5 — commit.** feat(core): v2 wire compiler — elements, attrs, deterministic ids.

### Task 4: queries, islands, text children, actions, source resolution

**Files:** modify `packages/core/src/wire-v2/compile.ts` + tests.

- [ ] **Step 1 — failing tests.** Query hoisting (top-level and nested-with-issue), name from `id` attr, tool + fn: validation, `input` expression; duplicate query name → issue + later one dropped; Island raw-TSX capture (source containing `<`, quotes, braces — never parsed), island name rules (PascalCase, reserved names rejected with issue); island-backed nodes get `source: "generated"`; host-list names get `source: "host"` (compiler option), prewired names get `source: "prewired"`, host beats prewired beats island for the same name; unknown component name → source undefined, no issue (renderer notices it); text child → Text node with the text prop, whitespace-only ignored; `onClick` string tool attr → canonical action object; bad fn: in action → issue; binding attributes referencing a query declared *later* in the wire still resolve (two-pass or forward-declaration handling — declared order is wire order, resolution is whole-document).
- [ ] **Step 2 — run to verify failure.**
- [ ] **Step 3 — implement** per D3/D5.
- [ ] **Step 4 — run to verify pass.**
- [ ] **Step 5 — commit.** feat(core): v2 wire compiler — queries, islands, actions, text.

### Task 5: valid-while-partial + limits

**Files:** modify `packages/core/src/wire-v2/compile.ts` + tests; create `packages/core/src/wire-v2/roundtrip.e2e.test.ts`.

- [ ] **Step 1 — failing tests.** Truncation property: for a rich fixture (queries + nested components + island + actions), EVERY prefix length compiles without throwing to a tree passing `validateTreeV2`, `complete` false until the end, node count monotonically non-decreasing at element-boundary prefixes; auto-close of open elements at EOF; incomplete trailing tag/attr/expression dropped; unterminated Island dropped entirely; caps: >TREE_MAX_QUERIES queries → first 16 kept + issue; oversized island source → dropped + issue; >max generated components → excess dropped + issue; node cap → accumulation stops + issue, tree still valid.
- [ ] **Step 2 — run to verify failure.**
- [ ] **Step 3 — implement** per D6.
- [ ] **Step 4 — run to verify pass.** Run the full core suite.
- [ ] **Step 5 — commit.** feat(core): v2 compiler — valid-while-partial + pinned limits.

### Task 6: app-document v2 branch + export surface

**Files:** modify `packages/core/src/app-document.ts`, `packages/core/src/index.ts`; tests in `packages/core/src/app-document.test.ts` (extend) or `tree-v2.test.ts`.

- [ ] **Step 1 — failing tests.** A document with a v2 tree + document-level components validates; a v2 tree carrying its own `components` member fails with the lift message; fn: refs in v2 queries/props without `server` fail with the existing machine-presence message; a `generated` node whose component is missing from document components fails; v1 documents and the format-drill suite still pass byte-for-byte.
- [ ] **Step 2 — run to verify failure.**
- [ ] **Step 3 — implement** the branch per D2, reusing `collectActionReferences` and `componentMapError`. Export everything new from `index.ts`.
- [ ] **Step 4 — run + full core suite + `pnpm --filter @vendoai/core typecheck`.**
- [ ] **Step 5 — commit.** feat(core): app documents accept vendo-genui/v2 trees.

### Task 7: ui v2 renderer + registration + host-wins fix

**Files:** create `packages/ui/src/tree/renderer-v2.tsx`, `packages/ui/test/tree/renderer-v2.test.tsx`; modify `packages/ui/src/tree/index.ts`, `packages/ui/src/tree/renderer.tsx`.

- [ ] **Step 1 — failing tests** (follow `tree-view.test.tsx` harness conventions, including the fluidkit alias stubbing the ui tests already use). Cases: `PayloadView` with a v2 payload renders the tree (was: unsupported-format notice); prewired primitives render; a host component (via the `components` prop) renders with bound props; `$path` bindings resolve against data keyed at `/` + query name; `$state` bindings + updates work; action props dispatch through `onAction` with the compiler-minted node id; an invalid v2 payload renders the contained validation notice, never throws; explicit `source: "host"` node whose name collides with a prewired name renders the HOST implementation (new behavior), while an undefined-source collision still renders the primitive (v1 behavior preserved — regression-assert in the existing tree-view suite); generated island node goes to the jail path (assert the jail component mounts; follow `frames-and-jail.test.tsx` precedent).
- [ ] **Step 2 — run to verify failure.** `pnpm --filter @vendoai/ui test -- renderer-v2`.
- [ ] **Step 3 — implement** per D7: the adapt-to-v1-walk module + module-scope `registerTreeRenderer` + tree index export + the one-line-scoped source-host preference change in the shared walk.
- [ ] **Step 4 — run + full ui suite** (`pnpm --filter @vendoai/ui test`) — the ui format-drill must still show the notice for truly unknown tags.
- [ ] **Step 5 — commit.** feat(ui): register the vendo-genui/v2 renderer on the v1 walk.

### Task 8: apps open-path v2 query resolution

**Files:** modify `packages/apps/src/open.ts`; extend the apps open/format-drill test coverage in `packages/apps/src/format-drill.test.ts` or the open tests.

- [ ] **Step 1 — failing tests.** Opening an app whose tree is v2: named queries execute through the existing caller seam and results land in the payload's data at `/` + name; source order preserved; a failing query leaves its slot absent and the payload still emits (containment); forged server fields stripped as today; a v1 app opens unchanged; an unknown-tag payload still passes through byte-identical (drill).
- [ ] **Step 2 — run to verify failure.** `pnpm --filter @vendoai/apps test -- format-drill` (and the open suite).
- [ ] **Step 3 — implement** per D8 — adapter around the existing progressive resolver, no resolver rewrite.
- [ ] **Step 4 — run + full apps suite.**
- [ ] **Step 5 — commit.** feat(apps): resolve v2 named queries on the open path.

### Task 9: round-trip gate — wire → compile → validate → render

**Files:** create `packages/core/src/wire-v2/roundtrip.e2e.test.ts` additions (compile+validate half) and a ui-side round-trip case inside `packages/ui/test/tree/renderer-v2.test.tsx` (compiled-fixture render half).

- [ ] **Step 1 — write the hand-written fixture** modeled on the spec §2 example against demo-bank's real host component names (check `apps/demo-bank` for its registered catalog names; use real ones so the same fixture drives the browser verification): queries, a grid of chart/table hosts, text, an action, an island.
- [ ] **Step 2 — assert the chain.** Core: compile → zero error-severity issues → `validateTreeV2` ok → id/binding/query invariants. UI: render the compiled tree with stub host components + data shaped like the queries' results; assert visible content and dispatched action shape.
- [ ] **Step 3 — run both suites; commit.** test: v2 wire→tree→render round-trip gate.

### Task 10: contract amendments + docs sync

**Files:** modify `docs/archive/contracts/01-core.md`, `docs/archive/contracts/08-ui.md`.

- [ ] **Step 1 — amend 01-core §8** per D9 (v2 canonical shape, named queries + `/`-name data residency, compiler-owned ids, wire grammar + valid-while-partial + issues, same limits, `compileWireV2`/`validateTreeV2`/`VENDO_TREE_FORMAT_V2` on the utility surface) with a dated amendment note citing the v2 spec as authority.
- [ ] **Step 2 — amend 08-ui §5** (v2 registered beside v1; host-wins on explicit host source; jail/binding semantics inherited).
- [ ] **Step 3 — commit.** docs: contract amendments for vendo-genui/v2.

### Task 11: full gate + browser verification + PR

- [ ] **Step 1 — repo gate.** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` at the root — all green (turbo-cached; dependency-guard runs inside lint).
- [ ] **Step 2 — browser verification** (CLAUDE.md bar: green tests alone don't count). Drive demo-bank (`pnpm --filter demo-bank dev`): seed/store an app whose document carries the compiled v2 fixture tree (via the demo's store/dev seam — find how demo apps are seeded; the fixture from Task 9 is the payload), open it in a real browser, verify live rendering (host-brand components, resolved query data, working action), screenshot. Also screenshot a v1 app in the same session to evidence coexistence. Save under `docs/verification/vendo-v2-wave1/` with a short README.
- [ ] **Step 3 — PR.** Branch is `yousefh409/vendo-v2-format`; push, open a PR titled for wave 1 with the screenshots embedded, the spec linked, and the gate results stated. Never commit to main.
- [ ] **Step 4 — update the Orca worktree comment** to "wave 1 green — PR #NNN open".

---

## Self-review notes (spec coverage check)

- Spec §1 three-formats-one-compiler → Tasks 1–5 (canonical + compiler), D7 (render = canonical). ✓
- Spec §2 wire rules: positional nesting/no wire ids (D3 ids), component resolution order (D3/Task 4), bindings by declared name (D4), Query-lines-first streaming benefit (hoisting keeps document order; engine ordering is wave 2), raw-TSX islands (Task 4), fn: unchanged (Tasks 1/4/6), §8 limits (Task 5). ✓
- Spec §6 coexistence: registry dispatch (Task 7), v1 stays registered + drill suites asserted throughout, no AppDocument envelope change (Task 6 is additive branch). ✓ Transpile-on-edit is wave 4 (D10).
- Spec §3 shape-aware binding: deliberately wave 3 (D10) — but D4's binding grammar and D6's issues list are the seams it plugs into.
- Wave-1 gate from spec §8: round-trip of a hand-written example (Task 9) + v1 coexistence green (Tasks 6–8 assertions) + green pipeline + browser screenshots (Task 11). ✓
