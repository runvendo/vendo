# Vendo v2 Wave 4 — edit dialect (+ v1 cleanup) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Per the repo owner's global rules this plan is code-free: it locks decisions, files, behaviors, and gates; the executing engineer writes the code test-first.

**Goal:** One edit dialect (spec §5): the model sees the app as JSX-wire markup with the compiler-stamped id anchors and emits a small patch in the SAME grammar; the compiler applies it deterministically, re-mints ids only for inserted nodes, and re-validates everything — validateTreeV2 plus the Wave 3 shape-check — so a bad edit is as unshippable as a bad create. Plus the staged v1 removal that belongs to this wave.

**Architecture:** Two new wire-v2 modules in `@vendoai/core`: a deterministic printer (canonical tree → wire markup, optionally id-annotated — the model's edit context) and a patch compiler (an `<Edit>` document of op elements in the existing element/attribute/expression grammar, applied against a base compile result). Both reuse the wave-1 scanners/attribute/expression layers and the wave-3 shape-check verbatim. The `@vendoai/apps` `edit()` wiring is DEFERRED until the Wave 2 engine branch merges (parallel-lane rule); the v1 sweep likewise lands after that rebase, as the closing act.

**Design authority:** spec §5 + §6 + Wave 4 (docs/superpowers/specs/2026-07-18-vendo-v2-format-spec.md). Do not re-litigate.

---

## Locked design decisions

### D1. Printer (`packages/core/src/wire-v2/print.ts`)
- `printWireV2({ tree, components, name }, { includeIds })` → the wire markup string: `<App name>` → queries in order → root's children recursively → islands last (the spec example's order). Text nodes print as bare text; props print as `attr="string"` / bare-true / `attr={expression}`; `{ action: "..." }`-only values print back as the string action form on their original attribute.
- Expression printing inverts the wave-1 grammar: bindings print as bare references (`$path` → dotted query path, `$state` → `state.key`), `$reshape` chains print as pipes, objects/arrays/literals as JSON5-lite (bare identifier keys where legal, double-quoted strings).
- `includeIds: true` stamps each element with its node id — the model-facing edit context (compile ignores wire ids by design, so this wire is context, not a create input). `includeIds: false` is the round-trip form.
- **Round-trip property (the printer's gate):** for any compile result, `compileWireV2(printWireV2(result))` reproduces tree, components, and name byte-identically with zero issues — pinned across the existing fixture corpus.
- Non-printable trees (hand-built ids not matching the mint pattern, exotic props) still print totally; the property is only guaranteed for compiler-produced trees.

### D2. Patch grammar (`packages/core/src/wire-v2/patch.ts`)
One document: `<Edit> ...ops... </Edit>`, ops are PascalCase elements in the SAME attribute/expression grammar (no JSON-ops dialect):
- `<Set id="node-id" attr=.../>` — merge the given attributes into the node's props (same action/expression compilation as create; wire-id rule inverted: here `id` is the anchor).
- `<Unset id="node-id" title .../>` — bare attribute names to remove from props.
- `<Insert into="parent-id" at={n}> ...component/text subtree... </Insert>` — compile children exactly like wave 1 (source resolution, caps, islands/queries NOT allowed inside — they are top-level ops); missing `at` appends.
- `<Remove id="node-id"/>` — node + entire subtree; the root is not removable.
- `<Move id="node-id" into="parent-id" at={n}/>` — reparent/reorder; moving a node into its own subtree or the root is an error op.
- `<Query id tool input?/>` — upsert by name; `<RemoveQuery id="name"/>` deletes (bindings to it then fail re-validation naturally).
- `<Island name>raw TSX</Island>` — upsert; `<RemoveIsland name="X"/>` deletes (generated nodes degrade sourceless, wave-1 stance).
- `<SetName name="..."/>` — the app name.

### D3. Apply semantics
- `compileWirePatchV2(patch, base, options)` where base is `{ tree, components, name }` (a prior compile/patch result) and options are the create compiler's (`hostComponents`, `toolShapes`).
- Deterministic and total: ops apply in document order against the evolving tree; a bad op (unknown target id, malformed attrs, cycle move) records an issue and is SKIPPED — the result is always the base with every valid op applied, never a throw, never a half-applied op.
- **Edit locality:** untouched nodes keep their ids AND their object identity in the nodes array (hot-swap keys off stable ids). Inserted elements mint fresh ids by continuing each component's ordinal past the maximum already present (never reusing a removed id within one patch application either).
- Result shape mirrors `WireCompileResult` (tree, components, name, issues, bindingErrors, complete) and re-runs validateTreeV2 + the wave-3 shape-check on the FINAL tree; `complete` is false when the patch document was truncated (parsed ops still apply).
- New issue codes (closed registry): `missing-edit` (document is not `<Edit>`), `unknown-target` (id/parent/query/island not found), `invalid-patch-op` (unknown op element, missing required anchor, bad index, root/cycle violations).

### D4. Deferred until the Wave 2 branch merges (then rebase and finish in THIS PR)
- `@vendoai/apps` `edit()` speaks the dialect: print-with-ids as model context, model emits `<Edit>`, `compileWirePatchV2` applies, bindingErrors route to the wave-3 repair path. No apps files touched before that merge.
- The full v1 sweep: zero `vendo-genui/v1` references repo-wide (93 files today; Wave 2's PR deletes the apps dialects; the walk/jail/binding mechanics survive as v2-native per spec §6). Playground/fixture payloads move to v2.
- Retrieval cache: lowest priority, skipped if time-pressed (spec ships it off-by-default).

## Tasks (TDD; commit each)
1. Printer + round-trip property tests (fixture corpus, includeIds both ways).
2. Patch compiler: parse + Set/Unset first, then Insert/Remove/Move, then Query/Island/SetName ops; per-op tests + determinism + totality + locality + re-validation incl. toolShapes.
3. Registry + exports (`printWireV2`, `compileWirePatchV2`, result types, new issue codes) + docs page section.
4. Gates + PR "v2 format Wave 4: edit dialect (+ v1 cleanup)" (browser gate: an edit applied live in the harness — patch a running v2 payload and screenshot before/after).
5. (post-Wave-2-merge, same PR) apps `edit()` wiring + full v1 sweep + zero-refs gate.
