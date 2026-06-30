# Flowlet F3b — Gen-UI renderer + declarative format (Design)

- **Issue:** ENG-180 (F3b · Gen-UI renderer + declarative format)
- **Date:** 2026-06-30
- **Status:** Design approved in brainstorming; pending written-spec review. Build-directly (no spike — F3a's spike de-risked the sandbox substrate this reuses).
- **Blocked by:** F1 (done, on `main`). **Builds on:** F3a (ENG-177, merged — provides the stage + `StageCapabilities` seam). **Related to:** F4 (ENG-181, component library) — decoupled by design.
- **Decoupling:** F3b builds against F1's *abstract* `RegisteredComponent` registry and F3a's frozen stage, not F4's concrete components. The format and the component implementations are orthogonal: F3b renders components *by name*; F4 fills the registry. Same discipline that kept F3a independent of F2.

## 0. How the format was chosen

Research-first format evaluation (A2UI / Crayon·OpenUI Lang / Vercel json-render / Thesys C1), scored against ENG-180's hard criteria: reference registered components by name inside a generated tree; prop-level `ui-delta` streaming; payload versioning; an owned/decoupled renderer; no network egress (CSP jail).

- **Thesys C1 — rejected.** Generating its DSL requires a call to `api.thesys.dev` (violates the egress jail) and the renderer is a closed-source SDK over an unpublished schema.
- **OpenUI Lang (Crayon) — strong on component-by-name, gaps elsewhere.** Streams at *node* granularity only (no prop-level delta), no payload version field, and is a custom DSL (loses native JSON structured-output/validation). Adopting it still leaves us building the delta layer and version envelope, plus a grammar dependency on Thesys's ecosystem. "Align with F4" is weak: F4 wraps OpenUI for *component implementations*, which is orthogonal to the wire format.
- **Vercel json-render — close, less formal.** JSON → Zod registry by name, progressive streaming; no formal prop-delta or version field.
- **A2UI (Google, Apache-2.0) — chosen.** Uniquely solves both F3b-specific deliverables natively: prop-level deltas via JSON-Pointer `updateDataModel`, and a built-in payload version field. JSON (native structured output + validation). Its security model — "UI as data, agent may only reference a client-owned catalog, no arbitrary code" — is identical to Flowlet's sandbox thesis. Renderer is fully ours; nothing crosses but data. A flat, ID-addressable node list is also the right shape for delta streaming (patch any node/prop by id/path without walking a nested tree).

**Decision:** adopt an **A2UI subset** as Flowlet's generated-payload format ("Flowlet GenUI v1"), render it with our own in-sandbox renderer. Pin to A2UI v0.9 semantics; our renderer is the stable surface, insulating us from A2UI's pre-1.0 churn.

## 1. What F3b is, and is not

F3b draws on the stage F3a built. It turns an agent-generated declarative tree into mounted UI inside the sandbox, meshing generated layout with registered brand components, and updating it incrementally as the agent streams.

- **In scope:** the **Flowlet GenUI v1 format** (the `generated` node payload, §2); the **renderer** that walks it and mounts it inside the F3a stage (§4), resolving names against the F1 registry + Flowlet primitives (§3); **`ui-delta` prop-level streaming** (§5); **loading/streaming visual states** (§5); **payload versioning** (§6); per-node error isolation (impl of F3a's contract).
- **Out of scope (F3a, done):** the sandbox, CSP egress jail, bridge transport, theme/state injection, host-component provisioning, the `StageCapabilities` seam. F3b consumes these.
- **Out of scope (F4):** the concrete brand component implementations. F3b renders them by name; F4 registers them.
- **Out of scope (F2):** the real LLM that *emits* the format. F3b builds against fabricated/stub payloads; F2's real stream is revalidated when it lands. (F2 may import the format types from `@flowlet/core` to emit, §7.)

## 2. The format — Flowlet GenUI v1 (an A2UI subset)

One `data-ui` part carries one `GeneratedNode` whose `payload` is a `GeneratedPayload`:

```ts
interface GeneratedPayload {
  formatVersion: "flowlet-genui/v1"; // payload version (§6)
  root: string;                      // id of the root node
  nodes: GenNode[];                  // flat list; children referenced by id
  data?: Record<string, unknown>;    // data model for $path bindings
}

interface GenNode {
  id: string;
  component: string;                 // catalog name: a layout primitive OR a registered component
  source?: "prewired" | "host";      // which catalog (default "prewired")
  props?: Record<string, PropValue>;
  children?: string[];               // child node ids
}

// A prop is a literal, or a binding into the payload's data model via JSON Pointer (RFC 6901).
type PropValue = unknown | { $path: string };
```

**Adopted from A2UI:** flat ID-addressed node graph (children-by-id); a separate data model bound via JSON Pointer; structural + prop-level deltas (§5); a version field (§6).

**Dropped (YAGNI) — the format stays pure data, no client-side logic:**
- A2UI **surfaces** multiplexing — one stage renders one tree.
- A2UI **Templates**, **`@builtins`** (`@Each`/`@Filter`/…), **Query/Mutation**, expressions/ternaries. The agent computes; the renderer only renders. This keeps the in-sandbox renderer small and removes an execution surface inside the security boundary.
- A2UI **catalog negotiation** — Flowlet's catalog is the registry, known at init.
- A2UI's **A2A wire framing** (DataPart MIME, message envelope) — Flowlet uses its own bridge (§5).

**Two binding sources, one resolver.** F3a already binds scoped *host* state into props via `{ $state: "key" }`. F3b adds `{ $path: "/pointer" }` for the *payload's own* data model. Both resolve in the renderer's prop-binding step; they are distinct sources (host-projected state vs. agent-generated content) and must not be conflated.

## 3. The catalog — registry + primitives (the meshing)

A `component` name resolves in order:

1. **Flowlet prewired primitives** — layout/atoms shipped inside the stage runtime: `Stack`, `Row`, `Grid`, `Text`, `Skeleton` (and the minimal set the renderer needs). These are not host components; they live in Flowlet's own stage bundle.
2. **F1 `RegisteredComponent` registry** — the brand components (`source: "host"` resolved via the provisioned bundle from F3a; `source: "prewired"` for registry-declared prewired ones). Resolved through F3a's `StageCapabilities.resolveComponent(name, source)`.

This is ENG-180's "reference registered components by name inside a generated tree / fast meshing of pre-built + generated UI": a generated tree drops `{ component: "AccountCard", source: "host" }` between `{ component: "Stack" }` nodes, in one walk. An unknown name renders a contained error placeholder (§6), never crashes the tree.

**Prop validation:** when a node resolves to a `RegisteredComponent`, its bound props validate against the descriptor's `propsSchema` (zod) before mount; a failure is a typed per-node error, not a thrown render.

## 4. The renderer — a compiled module inside the stage

The renderer runs **inside the sandbox** — the only realm with the resolved components + data, and the realm data cannot escape. F3a's runtime is currently a hand-written `STAGE_RUNTIME_SRC` string; a real A2UI renderer (parse → flat-graph walk → JSON-Pointer binding → delta reconciliation → skeletons → per-node error boundaries) is too much for a maintained string literal.

**Decision:** the renderer is **proper, unit-tested TypeScript compiled into the sandbox-runtime bundle**, using the same build approach F3a uses for the host bundle (Vite, externalized/shared React, `process.env.NODE_ENV` defined at build time — the F3a finding). The `STAGE_RUNTIME_SRC` bootstrap shrinks to: set up the DOM root, load the compiled renderer + shared React, wire the bridge, and hand incoming payloads/deltas to the renderer. The existing bridge handlers (`ui/initialize`, `ui/update`, `ui/action-result`, `ui/teardown`), capability map, action dispatch, auto-size, and theme injection are retained and refactored to call into the renderer module rather than inlining the render walk.

**Render walk:** resolve `root` → for each node, resolve `component` against the catalog (§3), bind props (`$state` + `$path`), wrap in a per-node error boundary, recurse over `children` (resolved by id). A child id not yet present in `nodes` renders a `Skeleton` (§5).

**State:** the renderer holds the current `{ nodes, data, theme, state }` and re-renders against React's persistent root (F3a's `window.__flowletRoot`). Re-renders are driven by deltas (§5), not full re-init.

## 5. `ui-delta` streaming + the bridge

F3b finalizes F3a's **provisional `subscribe` capability**: the renderer subscribes to model changes and re-renders affected nodes. Updates arrive over the existing `ui/update` bridge method, extended to two delta shapes:

- **Structural delta** — replace/add a node by id (F3a already has recursive replace-by-id; generalize to the flat node list, and rebuild the capability map so removed subtrees lose their tokens — the F3a invariant).
- **Prop-level delta (`ui-delta`)** — `{ data: { path, value } }` patches the data model at a JSON Pointer; **only nodes whose props `$path`-bind to (a prefix of) that path re-render.** This is the prop-granular update A2UI gives natively. `value` omitted = delete the key (A2UI semantics).

**Loading / streaming states.** While a payload streams, a node referenced as a child before its definition has arrived renders a **`Skeleton`** placeholder; when its node streams in (a structural delta), the skeleton is replaced. This is the visible "generating…" state. The `Skeleton` primitive is theme-aware (uses brand tokens).

**Mapping to `StageCapabilities` (frozen seam, unchanged):**
- `resolveComponent(name, source)` — catalog resolution (§3).
- `getState()` / `theme` — `$state` binding + theming (F3a).
- `subscribe(cb)` — now real: fires on structural or prop deltas.
- `dispatch(action)` — action descriptors in props → chokepoint (F3a, unchanged; approval-pending model intact).

## 6. Versioning + errors

**Payload versioning (deliverable #4).** `formatVersion: "flowlet-genui/v1"` is checked by the renderer on `ui/initialize`. A mismatch (or absent/unknown version) emits F3a's typed **`version`** error and renders a top-level error state rather than attempting a partial render. This is distinct from the envelope `SCHEMA_VERSION` in `@flowlet/core` (message-level); `formatVersion` versions the generated tree's own shape.

**Errors (reuse F3a's typed set):**
- `version` — `formatVersion` mismatch.
- `provision` — unknown component name → contained per-node error placeholder (existing `data-error`), siblings unaffected.
- per-node **error boundary** — a node that throws on render shows a contained boundary; the rest of the tree survives (F3a contract, now the real impl).
- malformed payload (missing `root`, dangling child id with no skeleton resolution path, non-pointer `$path`) → typed `bridge`/`provision` error, surfaced loudly, never a silent no-op.

## 7. Package layout

- **`@flowlet/core`** — gains the **format types + a validator** for `GeneratedPayload`/`GenNode`/`PropValue` (and a JSON-Pointer helper). It is a contract shared by the emit side (F2) and the render side (F3b); `core/ui.ts` already declares `GeneratedNode.payload` "format chosen by F3", so this fills it. *(If the format later grows a registry→system-prompt generation helper, extract a dedicated `@flowlet/genui` package; not now.)*
- **`@flowlet/stage`** — gains the **renderer module** (compiled into the sandbox runtime, §4) and the **prewired primitives** (`Stack`/`Row`/`Grid`/`Text`/`Skeleton`). Replaces the `[generated]` placeholder. Bridge/host largely unchanged; `ui/update` extended for prop deltas (§5).
- **`flowlet-react`** — the `FlowletStage` adapter is unchanged (it already mounts `@flowlet/stage`); a generated payload flows through the same path a component node does.
- **`examples/basic`** — gains a demo emitting a small generated payload (mixed primitives + a host component, a prop-delta update, a streamed skeleton) to exercise the path end to end.

## 8. Testing

- **Unit (vitest/jsdom):** format validation (good/bad payloads, version mismatch, unknown component); JSON-Pointer resolution (incl. delete-on-omit, prefix matching); flat-graph → element tree (children-by-id, cycle/dangling guards); `$state` + `$path` prop binding; **prop-delta reconciliation re-renders only `$path`-bound nodes**; skeleton for unresolved child → swap on structural delta; per-node error isolation; capability-map rebuild on structural delta.
- **Real-browser (Playwright + axe, existing `@flowlet/stage` CI):** a generated tree mounts in-sandbox under the CSP; a **prop-delta updates a live node without a full re-mount** (assert node identity / no from-scratch remount); skeleton→real swap is visible; a **mixed `component` + `generated` tree** coexists; **egress still blocked**; internal a11y holds (axe) on a generated tree.
- **Contract:** catalog resolution against the F1 registry; `propsSchema` validation; `ActionRequest` conformance unchanged; the `StageCapabilities` seam honored (no new methods — `subscribe` realized).

## 9. Risks

1. **A2UI is pre-1.0 (v0.9.1; v1.0 RC).** Mitigated by adopting a *subset* and owning the renderer — our format is `flowlet-genui/v1`, versioned independently; A2UI is the design reference, not a runtime dependency. We can track or diverge freely.
2. **Children-by-id flat graph is a different authoring model than a nested tree** for the emitting LLM. Mitigated: it is validatable (dangling ids → skeleton or typed error) and is the right shape for deltas. The F2 prompt side (out of scope here) carries the burden of correct id bookkeeping; F3b validates.
3. **Prop-delta reconciliation correctness** — re-rendering exactly the bound nodes (not over- or under-rendering) is the subtle part. Covered by targeted unit + real-browser identity tests (§8).
4. **Two binding sources (`$state`, `$path`)** could confuse authors. Mitigated by keeping them syntactically distinct and documented; the resolver treats them as separate sources.
5. **Renderer-into-runtime refactor** touches F3a's shipped runtime. Mitigated by the existing F3a real-browser CI guarding the sandbox behaviors against regression.

## 10. Open questions (resolved during implementation or deferred)

- Exact prewired-primitive set (`Stack`/`Row`/`Grid`/`Text`/`Skeleton` is the starting minimum) — grown only as the demo/tests require (YAGNI).
- Whether prop-delta subscription is coarse (any change → re-render bound subtrees) or fine (per-path memoization) — start coarse-correct, optimize only if a test shows over-render; `subscribe` stays the seam either way.
- JSON-Pointer support breadth (object/array indexing is needed; full RFC 6901 escaping `~0`/`~1` included; fancy edge cases deferred until exercised).
- The registry→system-prompt generation helper (turning `RegisteredComponent[]` into an LLM spec) — belongs with F2's emit side; F3b only defines/validates the format. Revisit a `@flowlet/genui` extraction then.
- Revalidate against F2's real generated stream when it lands (the spike/stub fabricates payloads).
