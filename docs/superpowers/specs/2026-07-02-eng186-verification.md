# ENG-186 verification — host-component reuse hardening

**Date:** 2026-07-02 · **Verifier:** eng-186-verify worktree · **Against:** main @ `0984d190`

## Question

Is ENG-186 ("Harden host-component reuse in generated UI") fully satisfied by the registration path that shipped with ENG-184 (PR #25: `docs/host-components.md`, `@flowlet/components` hostComponent/bindHostImpl/installFlowletHost)?

## Verdict: NOT fully satisfied — 3 of 4 scope items shipped; registry versioning did not

ENG-186 was found already closed as **Duplicate** in Linear (2026-07-02 02:55, no comment, no duplicate link). That closure is fine as triage — the bulk of the scope did land under ENG-184 — but one scope item is real, unshipped follow-up work.

## Requirement-by-requirement

### (a) Clean registration API: props schema + allowed values + agent-read docs — SATISFIED

- `hostComponent(name, description, zodSchema)` + `toHostRegistry` — `packages/flowlet-components/src/host-component.ts`. Fails fast at module load on non-PascalCase, reserved-primitive, or empty-description registrations (tested in `host-component.test.ts`).
- Allowed prop values are expressed as zod enums and read by validation — real example: `CadenceStatusBadge` `variant: z.enum(["missing","overdue","review","verified","neutral"])` in `apps/demo-accounting/src/flowlet/host-components/descriptors.ts`.
- Agent-read docs: descriptor `description` + per-prop `.describe()` are rendered into a HOST COMPONENTS system-prompt section — `apps/demo-bank/src/flowlet/agent.ts:50-53,128-133`; same pattern in demo-accounting and gmail. Developer docs: `docs/host-components.md`.
- Minor: the prompt section is hand-rolled per app (the doc instructs hosts to do this); no packaged helper.

### (b) Validation: agent can only pass schema-conforming props; clear rejection — SATISFIED (one limitation)

Three enforcement layers, all wired end-to-end and tested:

1. **Server, before streaming:** `validateGeneratedPayload` structurally validates the payload and returns a correctable error string to the model — `packages/flowlet-runtime/src/render-view-tool.ts:70-73`, `packages/flowlet-core/src/genui/format.ts`.
2. **GenUI resolution:** host-node props are validated against the descriptor's `propsSchema`; failures are replaced by a contained `[invalid props: X]` placeholder with siblings intact, and re-validated on data patches — `packages/flowlet-stage/src/genui-host.ts:42-84`, tests in `genui-host.test.ts` ("registry prop validation (B1)" suite).
3. **Adapter:** `bindHostImpl` re-parses props (inline fallback on failure) and wraps render in a per-node error boundary — `packages/flowlet-components/src/bind-host-impl.tsx`, tested.

Registry wiring verified: `FlowletProvider`/stage adapter pass the registry into `createGenUISession` (`packages/flowlet-react/src/stage-adapter.tsx:121`); demo-accounting passes `[...prewiredComponents, ...cadenceHostComponents]` at both surfaces (`FlowletRoot.tsx:58`, `SandboxStage.tsx:138`).

Exercised, not just read: full `@flowlet/components` (125 tests) and `@flowlet/stage` (69 tests) suites pass on main; a throwaway test ran the **real Cadence descriptors** through the shipped path — conforming props accepted, non-allowed enum value rejected, `source:"host"` stamped, all three registration fail-fast cases throw. 4/4 passed.

- Limitation: host-prop **schema** violations are not fed back to the model as a tool error — only structural payload errors are. Rejection is render-side (contained placeholder), so the "repair" half of "reject/repair" doesn't exist for descriptor-schema violations.

### (c) Registry versioning so host-component changes don't break saved flowlets — MISSING

- `SavedFlowlet` persists `uiTree` with **no registry-version field** — `packages/flowlet-core/src/seams/store.ts:50-60`.
- `flowletHostPreset({ version })` stamps `__FLOWLET_BUNDLE_VERSION__` into the sandbox bundle for traceability only (`packages/flowlet-stage/src/build/preset.ts`); nothing reads it for compatibility.
- What exists instead is graceful degradation: a renamed component renders an "Unknown component" notice; a changed schema renders the invalid-props placeholder; siblings survive. Saved flowlets don't *crash*, but they silently degrade — there is no version pin, no compat detection, no migration or "this flowlet references outdated components" surface.

### (d) DX: clear errors for unknown/unavailable components — SATISFIED

- Unknown name → visible per-node dashed notice `Unknown component "X"` in the sandbox — `packages/flowlet-stage/src/runtime.ts:285-298`.
- Bad registration → throws at module load (build-time). Catalog-name collision → `installFlowletHost` throws with a rename instruction — `packages/flowlet-components/src/sandbox-install.ts:53-61`.
- Minor: `sandbox-install.ts`'s top docstring stale-claims collisions "shadow deliberately" while the code throws; the unknown-component notice has no unit test pinning it (behavior confirmed by code read + ENG-184 audit).

## Follow-up scope (identified, then BUILT same day — see addendum)

1. **Registry versioning (the real gap):** stamp a registry version (or per-descriptor content hash) into `SavedFlowlet` at save time; on reopen, diff against the live registry and surface renamed/schema-changed components (warn/repair) instead of silent degradation. Additive change to the Store seam.
2. **Model-visible schema rejection (small):** validate host-node props against the registry server-side in `render_view` (the runtime can receive the registry) so the model gets a correctable error and can repair before render.
3. **Trivial:** fix the stale `sandbox-install.ts` docstring; add a unit test for the unknown-component notice; consider a packaged prompt-section helper (`hostComponentCatalog`) instead of per-app copies.

## Linear action taken

Left ENG-186 closed as Duplicate (its state when verification started); did **not** mark Done at verification time — item (c) was unshipped. ENG-186 is archived, so Linear rejects comments; this report is the record.

## Addendum (same day): all three follow-ups implemented

Yousef asked for the follow-ups to be built immediately. What shipped (this branch):

1. **Registry versioning** — `RegisteredComponent.version?` (`flowlet-core/src/registry.ts`) + `hostComponent(..., { version })`; saved flowlets stamp host-component `name → version` at save (`stampHostComponents`, wired in all three apps' draft derivation) into the shell `Flowlet.components` field (+ parity field on core `SavedFlowlet`); `useReopenFlowlet` returns `drift: { missing, changed }` diffed against the `FlowletShellProvider` `components` registry (`flowlet-shell/src/component-drift.ts`); each app's `SavedPane` renders a quiet `.fl-drift-note` naming the drifted components. Versions are host-declared (bump on breaking change; unset = "1"); hashing zod schemas was rejected — zod v3 has no stable serialization, and an explicit version is honest about what "breaking" means. Pre-versioning records diff clean (no retroactive warnings).
2. **Model-visible schema rejection** — `hostPropIssues(payload, registry)` in `flowlet-core/src/genui/host-props.ts` ($path bindings resolved before validation; $state-bound nodes and async schemas skipped, mirroring the stage); `render_view` returns `render_view error (host): …` per issue when the engine gets `components` (threaded via `FlowletAgentConfig.components`; all three demo agents pass their registries). Unknown host names error server-side too, listing what IS registered.
3. **Trivia** — `sandbox-install.ts` docstring fixed; unknown-notice marker test added to `runtime.test.ts`; `componentPromptCatalog` added to `@flowlet/components/descriptors` and the three hand-rolled per-app copies deleted.

**Verified:** full workspace suite green (1,125 tests incl. 19 new); typecheck green; lint green on all touched packages (5 pre-existing demo-bank errors reproduced on the clean tree, untouched files — reported, not fixed). Browser-verified in the running Cadence app: a saved view seeded with a drifted stamp shows the note (`verification/eng186-hardening/eng186-drift-note.png`), a matching stamp shows none (`eng186-no-drift.png`); the view itself renders in both cases — drift warns, never blocks.
