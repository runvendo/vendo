# Vendo v2 microapp format + generation pipeline — design spec

Status: design authority for the v2 build. Every major choice below is backed by a measured
result from the genui-bench benchmark (rounds 1+2, 2,325 real judged runs, `runvendo/genui-bench`),
not a guess. This spec is the input to (b): a separate build session implements it into the real
`@vendoai/*` packages. Contracts are unfrozen for the v2 re-derivation.

## 0. What the benchmark decided (so we don't re-litigate)
- **Emitted format = JSX-like markup.** Beat JSON tree / line-DSL / opcode on first paint + judged quality, zero CLS. (Round 1, Fork 1.)
- **Pipeline = tier0-wired.** An instant, fully-*wired* generic app paints in ~3.3s while a thinking pass upgrades it in place; best paint AND best quality of everything tested. Plus a no-think switch on the paint lane (cheapest win) and a retrieval cache for repeat requests. (Round 2.)
- **The wall is hidden model deliberation** (Experiment 0: 16s p50 of thinking; queue/prefill/decode ≈ 0). Format+pipeline on a BYO API top out ~3.3s paint; **<1s/<10s needs owned serving** — out of scope for this build, documented as the moat with falsifiable offline experiments.
- **The #1 correctness gap = data-shape mismatch.** The model binds components to tool responses blind and mis-labels fields (the "valid table, empty rows" / broken-chart class). **Shape-aware binding is a first-class feature of v2, not an afterthought.**
- **All four rungs stay** (tree / tree+fn / server-computed tree / full web app). This spec is the rung-1..3 UI format + engine; rung-4 and the server sandbox are unchanged and out of scope here.

## 1. The core architecture: three formats, one compiler
The single most important structural decision (independently converged on by every design agent): **what the model emits is NOT what we store or render.** A deterministic compiler sits between.

1. **Wire format (what the model emits): JSX-like markup.** Optimized for model fluency, token density, and paint-order streaming. Never executed — it is data that looks like code.
2. **Canonical format (what we store/validate/edit): the tree, tagged `vendo-genui/v2`.** A normalized structure the renderer, validator, and edit dialect consume. **The compiler owns all node ids** — the model never mints them.
3. **Render format: the same canonical tree**, rendered in the sandboxed iframe exactly as v1's tree is (jailed, guard-checked, brand-native).

The **compiler** (deterministic, total, ~1ms) parses the JSX-like wire into the canonical tree: mints stable ids, resolves bindings, lifts code islands, validates against the catalog. A truncated wire stream compiles to a valid smaller tree (valid-while-partial).

This is why the format change is low-risk: renderer, jail, guard, `fn:` machinery, and the `formatVersion` dispatch (`packages/core/src/app-document.ts`) are reused. Only the wire encoder/decoder is new.

## 2. The wire format (JSX-like markup)
Same runtime semantics as v1's tree; different surface syntax. Illustrative:

```
<App name="Cash Overview">
  <Query id="revenue" tool="metrics.revenue"/>
  <Query id="payments" tool="payments.list" input={{ limit: 5 }}/>
  <Stack gap={16}>
    <PageHeader title="Cash Overview" subtitle="…"/>
    <Grid cols={3}>
      <LineChart title="Revenue" points={revenue | asPoints(month, revenue)}/>
      <DataTable rows={payments} columns={[…]}/>
    </Grid>
  </Stack>
  <Island name="…">export default function …</Island>
</App>
```

Rules:
- **Positional nesting; no ids on the wire.** The compiler mints stable ids at parse time (so the canonical tree and the edit dialect still address nodes by id).
- **Components** resolve, in order: host catalog → prewired primitives → local `<Island>` generated components. Host brand wins.
- **Bindings** reference declared `<Query>`/state by name (`points={revenue}`); the compiler converts to canonical `$path`/`$state` bindings. `<Query>` lines come first so data fetching (through the guarded host tools) starts while the rest streams.
- **Actions** are attributes naming a host tool or an `fn:` reference; parsed to the canonical guard-checked dispatch. Unchanged security semantics.
- **Code islands**: `<Island name="…">` holds **raw TSX** (no JSON escaping — the v1 pain), compiled + sandboxed exactly like today's `components` map. Client-side, jailed, no authority. (Distinct from server `fn:` code, which is rungs 2–4.)
- **`fn:` references** work identically to v1 — a tree that names `fn:foo` targets the app's machine (rungs 2–3). No change to the server contract.

The compiler enforces the pinned limits (nodes, components, island bytes) from core §8.

## 3. Shape-aware binding (the correctness feature — new in v2)
The benchmark proved the model mis-binds because it never sees the data shape. v2 fixes this structurally:
- **At generation time, the engine gives the model the real (or sampled) response shape of each host tool / `fn:`** — field names, types, nesting — as part of the catalog/tool context (a "shape card" per tool, derived at `vendo sync` or from a live/recorded sample; values hashed away, only shapes kept).
- **The wire format supports a bounded reshape** in bindings (`revenue | asPoints(month, revenue)` — a small, pure, non-Turing projection vocabulary: field-rename, pick, map, format, aggregate) so the model can adapt `{month, revenue}` → `{label, value}` without a code island.
- **The compiler type-checks bindings against the shape card**: a component bound to fields that don't exist in the tool's response shape is a compile error routed to per-binding repair — the broken chart becomes an unshippable state, caught before the user sees it.
- Where no shape is known, the type is `Json`, the projection must be defensive, and the region renders a contained data-shape notice rather than a broken render.

This is the single highest-value correctness change; it must ship with the format, not after.

## 4. The generation pipeline (tier0-wired)
Implemented behind the existing `GenerationEngine` seam in `@vendoai/apps` (the `create`/`edit` entry; replaces `modelEngine` internals, not the seam).

- **Tier-0 lane (instant, no extended thinking):** emits a complete, *fully-wired* generic app — catalog components with conservative defaults, real `<Query>` bindings, read tools live, mutating actions rendered but confirm-gated, statically-validated against tool shapes, zero islands. Paints in ~2.5–3.3s. Never a blank screen.
- **Tier-2 lane (full thinking, in parallel):** the real generation, conditioned on tier-0's layout header, hot-swaps subtree-by-subtree preserving client state by stable id; a tier-2 error/deopt falls back to the resident tier-0 (never a white box).
- **No-think switch:** the paint lane runs with extended thinking off (measured: no quality cost, big paint win). Make it a config knob.
- **Retrieval cache (repeat traffic):** an optional front cache keyed per host; certified hits paint a prior app instantly with a tiny no-think verify. Honest fall-through to full generation on novel requests (leave-task-out proven). Ships as an optional layer, off by default.

## 5. Edit flow (one dialect)
Edits operate on the JSX-like wire against the compiler-stamped ids (the model sees the markup with id anchors; emits a small patch in the same grammar). No second JSON-ops dialect. The compiler applies deterministically and re-validates (including shape-checks). Undo/version via the existing history machinery.

## 6. Coexistence + migration (reuse the existing seam)
- Register `vendo-genui/v2` behind the `formatVersion` dispatch in `packages/core/src/app-document.ts` / `tree.ts`. The v1 renderer/validator stay registered forever; stored v1 apps keep working (the forward-compat tests already prove unknown-format tolerance).
- The engine emits v2 for new creates once the runtime advertises the v2 renderer; v1 apps transpile to v2 on first edit (v1 tree → v2 tree is mechanical and total).
- No breaking change to `AppDocument` envelope, `fn:`, grants, storage, or the rung ladder — only the tree payload format is new.

## 7. Out of scope for this build (named, not forgotten)
- **Owned serving** (prefill set-heads, zero-think KV-fork, host LoRA, diffusion AST, custom tokenizer) — the sub-second moat; each has a falsifiable offline experiment in the genui-bench report. Separate initiative.
- **Rung-4 / server sandbox generation** — unchanged; a future benchmark track.

## 8. Implementation roadmap (waves — (b) plans each with writing-plans)
1. **Wave 1 — format + compiler + renderer.** `vendo-genui/v2` canonical tree in core; the JSX-like wire grammar + deterministic compiler (ids, bindings, islands, `fn:`); the v2 renderer in ui (reusing the v1 render path). Gate: round-trip wire→tree→render of a hand-written example, v1 coexistence green.
2. **Wave 2 — tier0-wired engine.** The two-lane engine behind `GenerationEngine` in apps (tier-0 instant + tier-2 hot-swap + no-think switch). Gate: a real generation paints wired in <~3.5s and upgrades in place, verified in a browser.
3. **Wave 3 — shape-aware binding.** Shape cards from `vendo sync`/samples; the bounded reshape vocabulary; compiler type-check + per-binding repair. Gate: the chart-bug class fails at compile and repairs; measured coverage up vs. Wave 2.
4. **Wave 4 — edit dialect + retrieval cache + migration.** One-dialect edits; optional repeat-cache; v1→v2 transpile. Gate: edit locality + v1 apps still render.
Each wave: `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; UI-affecting changes verified in a real browser with screenshots; branch + PR (never commit to main).

## 9. Verification bar
The build is not "done" on green tests alone. Each wave is verified by driving a real generation in a browser and screenshotting the result — the same bar the benchmark held. The final integration re-runs the genui-bench tier0-wired + shape-aware variants against the *real* engine to confirm the product matches the prototype's measured numbers.
