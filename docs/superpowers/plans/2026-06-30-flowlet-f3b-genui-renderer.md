# Flowlet F3b — Gen-UI Renderer + Declarative Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per the repo's plan convention, tasks are described at goal level — the controller supplies concrete code/signatures to each implementer at dispatch time.

**Goal:** Turn agent-generated `generated` UINodes into mounted UI inside the F3a stage, using a Flowlet GenUI v1 (A2UI-subset) declarative format that references registered components by name, supports prop-level `ui-delta` streaming, and carries a payload version.

**Architecture:** The format "brain" runs **host-side** (pure, unit-tested TS): validate the payload, resolve its flat ID-addressed graph + data model into a nested bound tree shaped exactly like the component tree F3a already renders, and recompute affected nodes on a data patch. The **sandbox runtime** (the existing `STAGE_RUNTIME_SRC` string) changes minimally — it gains a built-in set of prewired primitives (`Stack`/`Row`/`Grid`/`Text`/`Skeleton`). Generated nodes therefore flow through F3a's proven `ui/initialize` + replace-by-id paths; prop-deltas are sent inward as replacements and React reconciles by stable key (no remount).

**Tech Stack:** TypeScript, pnpm workspaces, Vitest (jsdom/node), Playwright + axe (real-browser CI), React (in-sandbox via shared-React import map). Builds on `@flowlet/core` (F1 contracts) and `@flowlet/stage` (F3a).

**Spec:** `docs/superpowers/specs/2026-06-30-flowlet-f3b-genui-renderer-design.md`

**Decoupling guardrails (do not violate):** Never weaken the F3a CSP egress jail (`connect-src 'none'`, `img-src data:`, no `allow-same-origin`). Sandbox→host stays data-only. The format references components by name through F1's abstract registry — no dependency on F4's concrete components. The format stays pure data (no expressions/logic). Build against F1's contracts and fabricated payloads, not F2.

---

## File Structure

**`@flowlet/core` (new `src/genui/` module — the format contract + pure resolver):**
- `src/genui/format.ts` — types (`GeneratedPayload`, `GenNode`, `PropValue`), the `FLOWLET_GENUI_VERSION` constant, and `validateGeneratedPayload`.
- `src/genui/pointer.ts` — RFC 6901 JSON-Pointer `resolvePointer` + immutable `applyPointerPatch` (omit value = delete).
- `src/genui/resolve.ts` — `resolveGeneratedPayload` (flat graph → nested bound `UINode` tree, binds `$path`, marks unresolved children as `Skeleton`, guards cycles/dangling) and `collectBindings` (node → the pointers its props reference).
- `src/genui/index.ts` — barrel; re-exported from `src/index.ts`.
- Tests co-located: `format.test.ts`, `pointer.test.ts`, `resolve.test.ts`.

**`@flowlet/stage` (host-side session + runtime primitives):**
- `src/genui-host.ts` — `createGenUISession(payload)`: holds the data model, exposes the resolved initial `tree`, and `applyDataPatch(path, value?)` → the list of `{ nodeId, node }` replacements to push inward. Built on `@flowlet/core`'s resolver. Unit-tested.
- `src/runtime.ts` — extend the string runtime with a `PRIMITIVES` map (`Stack`/`Row`/`Grid`/`Text`/`Skeleton`) and resolve `source: "prewired"` names against it before falling back to the host bundle.
- `src/index.ts` — export the genui-host surface + `StageUpdatePayload` stays the carrier for replacements.

**`flowlet-react` (adapter wiring):**
- `src/stage-adapter.tsx` — when a `data-ui` node is `generated`, resolve via a `GenUISession` and initialize with its tree; on a subsequent generated node whose `data` changed but structure did not, send prop-deltas (replacements) instead of re-initializing.

**Tests / example / docs:**
- `packages/flowlet-stage/tests/browser/fixtures/host.ts` — new `?case=` payloads (generated tree, mixed, prop-delta, skeleton).
- `packages/flowlet-stage/tests/browser/gate-generated.spec.ts`, `gate-ui-delta.spec.ts`, `gate-skeleton.spec.ts` — new real-browser gates.
- `examples/basic/src/` — a demo emitting a generated payload + a prop-delta.
- `packages/flowlet-core/README.md`, `packages/flowlet-stage/README.md` — document the format + host-side resolution.

---

## Task 1: GenUI format types + validator

**Files:** Create `packages/flowlet-core/src/genui/format.ts`, `packages/flowlet-core/src/genui/format.test.ts`.

**Goal:** Define the Flowlet GenUI v1 type contract and a validator that is the single gate for a `generated` payload.

**Approach:**
- Types: `GeneratedPayload` = `{ formatVersion; root; nodes; data? }`; `GenNode` = `{ id; component; source?; props?; children? }`; `PropValue` = a literal or a `{ $path }` binding. Export `FLOWLET_GENUI_VERSION = "flowlet-genui/v1"`.
- `validateGeneratedPayload(input)` returns a discriminated result: success with the typed payload, or a typed failure carrying an `ErrorCode` (`version` for a missing/mismatched `formatVersion`; `provision` for structural problems — absent `root`, a `root`/`children` id with no matching node, a node missing `id`/`component`). Pure; no throwing.

**Tests (assert behavior, not internals):** valid payload passes; wrong/absent `formatVersion` → `version` failure; missing `root` node, dangling child id, node without `component` → `provision` failures; a well-formed minimal single-node payload passes.

**Acceptance:** `pnpm --filter @flowlet/core test` green; types exported from the package barrel.

**Commit:** `feat(core): Flowlet GenUI v1 format types + validator (ENG-180)`

---

## Task 2: JSON-Pointer resolve + immutable patch

**Files:** Create `packages/flowlet-core/src/genui/pointer.ts`, `packages/flowlet-core/src/genui/pointer.test.ts`.

**Goal:** The data-binding primitive: read and patch the payload `data` model by RFC 6901 JSON Pointer.

**Approach:**
- `resolvePointer(data, pointer)` → the value at the pointer (root pointer returns the whole model; unknown path returns `undefined`); supports object keys and array indices and the `~1`/`~0` escapes for `/` and `~`.
- `applyPointerPatch(data, pointer, value?)` → a new model with the value set at the pointer; omitting `value` deletes the key (A2UI semantics). Immutable — never mutates the input.

**Tests:** resolve nested object + array index; escaped keys; unknown path → `undefined`; patch sets a deep value without mutating the original; patch with no value deletes; root-pointer behaviors.

**Acceptance:** core tests green.

**Commit:** `feat(core): RFC 6901 JSON-Pointer resolve + immutable patch (ENG-180)`

---

## Task 3: Flat-graph resolver + binding collector

**Files:** Create `packages/flowlet-core/src/genui/resolve.ts`, `packages/flowlet-core/src/genui/resolve.test.ts`, `packages/flowlet-core/src/genui/index.ts`; modify `packages/flowlet-core/src/index.ts` to export the genui barrel.

**Goal:** The core transform: a validated `GeneratedPayload` → the nested bound `UINode` tree the F3a runtime already renders.

**Approach:**
- `resolveGeneratedPayload(payload)` walks from `root`, resolving `children` ids into nested `UINode` component nodes (`kind: "component"`, carrying `source`, `name`, bound `props`, nested `children`). Each `{ $path }` prop is replaced with the value read from `payload.data` via `resolvePointer`. A child id that has no node yet resolves to a `Skeleton` placeholder node (`source: "prewired"`, `name: "Skeleton"`). `$state` bindings are left intact (the runtime binds host scoped state, unchanged from F3a). Guards: a cycle or a node visited twice resolves to a contained error placeholder rather than recursing forever.
- `collectBindings(node)` → the list of pointers referenced by that node's top-level `$path` props (used by Task 5 to know which nodes a data patch affects).

**Tests:** a flat 3-node payload resolves to the expected nested tree; a `$path` prop binds to the data value; a registered host component reference is preserved with `source: "host"`; a child id absent from `nodes` becomes a `Skeleton`; a cycle resolves without infinite recursion; `collectBindings` returns the pointers a node binds.

**Acceptance:** core tests green; `resolveGeneratedPayload` output validates against the existing `UINode` type so it can feed `StageInitPayload.tree`.

**Commit:** `feat(core): GenUI flat-graph resolver + binding collector (ENG-180)`

---

## Task 4: Prewired primitives + skeleton in the sandbox runtime

**Files:** Modify `packages/flowlet-stage/src/runtime.ts`; modify `packages/flowlet-stage/src/runtime.test.ts`.

**Goal:** Make `Stack`/`Row`/`Grid`/`Text`/`Skeleton` resolvable in-sandbox so resolved generated trees render without depending on the host bundle.

**Approach:**
- Add a `PRIMITIVES` map inside the runtime string: minimal React components — `Stack` (flex column), `Row` (flex row), `Grid` (CSS grid), `Text` (text element reading its `text`/children), `Skeleton` (a theme-aware placeholder block). They use brand CSS vars so theming applies.
- In the runtime's component resolution, when `source === "prewired"` resolve the name against `PRIMITIVES` first, then fall back to the host bundle (preserves the existing `__row`/`__badge`-via-bundle behavior, so F3a tests do not regress).

**Tests (vitest, via the runtime-source extraction pattern already used in `runtime.test.ts`):** the runtime source contains the new primitive markers; the resolution prefers `PRIMITIVES` for known prewired names and falls back otherwise. (Visual rendering is covered by the browser gates in Task 7.)

**Acceptance:** `pnpm --filter @flowlet/stage test` green; existing F3a vitest + browser gates still pass.

**Commit:** `feat(stage): built-in prewired primitives + skeleton in sandbox runtime (ENG-180)`

---

## Task 5: Host-side GenUI session (data model + prop-delta recompute)

**Files:** Create `packages/flowlet-stage/src/genui-host.ts`, `packages/flowlet-stage/src/genui-host.test.ts`; modify `packages/flowlet-stage/src/index.ts` to export it.

**Goal:** Own the live data model host-side and translate a `ui-delta` data patch into the minimal set of node replacements to push inward.

**Approach:**
- `createGenUISession(payload)` validates (Task 1), resolves the initial `tree` (Task 3), and builds a reverse index (pointer → node ids) from `collectBindings`.
- `session.tree` — the resolved initial tree for `StageInitPayload.tree`.
- `session.applyDataPatch(path, value?)` — patches the held data model (Task 2), determines affected node ids (a node is affected when one of its bound pointers is equal to, a prefix of, or prefixed by `path`), re-resolves just those nodes, and returns `{ nodeId, node }[]` for the host to send via `controller.update({ replace })`.

**Tests:** session exposes the resolved tree; a patch to a bound pointer returns exactly the affected node(s) with updated props; a patch to an unbound pointer returns an empty list; nested/prefix pointer matching behaves as specified; delete-patch propagates.

**Acceptance:** stage tests green; the session has no DOM/`window` dependency (pure, like `connectStage`).

**Commit:** `feat(stage): host-side GenUI session with prop-delta recompute (ENG-180)`

---

## Task 6: Adapter renders generated nodes + drives `ui-delta`

**Files:** Modify `packages/flowlet-react/src/stage-adapter.tsx`, `packages/flowlet-react/src/stage-adapter.test.tsx`.

**Goal:** Route a `generated` `data-ui` node through a `GenUISession` and turn a data-only payload change into prop-deltas rather than a full re-initialize.

**Approach:**
- When the incoming node is `generated`: create a `GenUISession`, initialize the stage with `session.tree` (theme/state handled as today). Hold the session across renders.
- On a later generated node with the same structure but changed `data`: diff the changed pointers, call `session.applyDataPatch` for each, and send the resulting replacements through `controller.update({ replace })`. On a structurally different payload (or a non-generated node): re-initialize as today.
- A validation failure surfaces the typed error through the adapter's existing error path (no throw across the boundary).

**Tests (jsdom, mock stage controller):** a generated node calls `initialize` with the resolved tree; a data-only change calls `update({ replace })` (not `initialize`) with the affected node(s); a structural change re-initializes; an invalid payload surfaces a `version`/`provision` error without throwing.

**Acceptance:** `pnpm --filter @flowlet/react test` green.

**Commit:** `feat(react): render generated nodes + ui-delta via GenUISession (ENG-180)`

---

## Task 7: Real-browser gates (mount, mixed, prop-delta no-remount, skeleton)

**Files:** Modify `packages/flowlet-stage/tests/browser/fixtures/host.ts` (new `?case=` payloads + a global hook to drive a data patch); create `packages/flowlet-stage/tests/browser/gate-generated.spec.ts`, `gate-ui-delta.spec.ts`, `gate-skeleton.spec.ts`.

**Goal:** Prove the highest-risk behaviors in a real CSP-sandboxed iframe (jsdom cannot).

**Approach:**
- `gate-generated` — a resolved generated tree (primitives + a host component referenced by name) mounts and is visible; a mixed `component` + `generated` sibling tree coexists.
- `gate-ui-delta` — drive `session.applyDataPatch` + `controller.update({ replace })` for a prop change and assert the target node's text updates **without a remount** (assert DOM-node identity is preserved across the update, e.g. via a stamped attribute or element handle, so it is a prop update, not a from-scratch re-mount).
- `gate-skeleton` — a payload with a forward-referenced (not-yet-defined) child renders a `Skeleton`; a follow-up replace swaps in the real node.
- Re-assert egress stays blocked on a generated tree (reuse the existing egress probe pattern).

**Tests:** the three gates above, plus an axe pass on a generated tree (internal a11y holds).

**Acceptance:** `pnpm --filter @flowlet/stage test:browser` green (after `build:all-bundles` per the existing harness); existing F3a gates still pass.

**Commit:** `test(stage): real-browser gates for generated render, ui-delta, skeleton (ENG-180)`

---

## Task 8: Example demo + docs sync

**Files:** Modify `examples/basic/src/App.tsx` (and a small payload helper if needed); modify `packages/flowlet-core/README.md`, `packages/flowlet-stage/README.md`.

**Goal:** Exercise the full path end-to-end and document the format + host-side resolution.

**Approach:**
- Example: emit a small generated payload (a `Stack` of a `Text` + a host component referenced by name, bound to a `data` model) and a button that applies a prop-delta, visibly updating one node.
- Docs: add a concise "Flowlet GenUI v1 format" section to the core README (payload shape, component-by-name, `$path` bindings, versioning) and a "host-side resolution + `ui-delta`" note to the stage README. Succinct, no filler.

**Tests:** example typechecks and builds (`pnpm --filter <example> build`); no new unit tests required beyond the build.

**Acceptance:** example builds and renders the generated UI + delta; whole-workspace `typecheck + build + test` green.

**Commit:** `docs(f3b): example generated-UI demo + format/resolution docs (ENG-180)`

---

## Final verification (after all tasks)

- [ ] Whole-workspace `typecheck`, `build`, `test` green (root scripts).
- [ ] `@flowlet/stage` `test:browser` green (all F3a + new F3b gates).
- [ ] Spec §2–§8 each map to a shipped task (coverage check below).
- [ ] No weakening of the F3a CSP/egress model; sandbox→host still data-only.
- [ ] Dispatch a final whole-implementation code review (subagent-driven step 7), then finish via finishing-a-development-branch.

**Spec coverage map:** §2 format → T1; JSON-Pointer/§5 binding → T2; §3 catalog + §4 resolution + skeleton → T3/T4; prewired primitives → T4; §5 `ui-delta` → T5/T6/T7; §6 versioning/errors → T1 (+ surfaced in T6); §8 testing → T1–T7; example/docs → T8.
