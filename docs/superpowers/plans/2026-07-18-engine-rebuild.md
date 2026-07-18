# Engine Rebuild (v2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute wave-by-wave. Waves are fleet-executable; tasks within a wave may run in parallel unless a dependency is noted. This is a HIGH-LEVEL plan by design — task owners derive code-level detail from the spec, not from this file.

**Goal:** Rebuild the app-generation engine on the format-v2 design — VMX wire dialect, total compiler, `vendo-genui/v2` stored format, macro-first streaming renderer, hosted serving behind a swap-ready seam, one edit dialect — and delete the v1 machinery it replaces.

**Blueprint:** `docs/superpowers/specs/2026-07-17-format-v2-design.md` (all §7 recommendations are ACCEPTED decisions). Deletion mandate: `docs/superpowers/specs/2026-07-16-simplify-v2-kill-list-design.md` §A1/A2/A3.

**Architecture:** The model emits VMX markup; a deterministic total compiler owns ids and produces the canonical v2 document (macros expanded, provenance recorded, authored text retained). The renderer mounts elements as they commit, with macro-reserved geometry for zero CLS and a pre-model local skeleton for first paint. Generation serving is an adapter (`GenerationServing`): hosted inference at launch, owned serving as a later config swap. Edits are anchored VMX patches through the same compiler; pins ride the island module machinery. When the v2 path is default and a v1→v2 up-converter exists, the v1 generation stack (sandbox fork/swap/snapshot, edit dialects + tree-op interpreter, incremental-tree streaming parser) is deleted.

**Standing rules for every task:**

- Contracts system is RETIRED. No contract-doc updates in any task; the types and tests ARE the contract.
- One machine per app; edits apply in place. No fork/swap/resume anywhere in new code.
- The one security rule holds everywhere: the format never carries authority; every callable is guard-checked at dispatch.
- TDD per repo norms; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before any wave PR; UI-affecting waves require real-browser screenshots in the PR.
- Each wave lands as one or more PRs off main; a wave is "done" only when its gate evidence (tests / browser artifacts / bench numbers) is in the PR.

---

## Wave map

```
Wave 1 (compiler + stored format)
  ├─→ Wave 2 (stdlib/macros + renderer/streaming)   [needs 1]
  │        └─→ Wave 3 (serving seam + hosted pipeline) [needs 1+2]
  │                 └─→ Wave 4 (edits + pins + approvals threadId) [needs 3]
  │                          └─→ Wave 5 (up-converter + deletions) [needs 4]
```

Waves 1 and the stdlib half of Wave 2 can be staffed concurrently once the compiler's macro-expansion interface stabilizes (Task 1.3); everything else is sequential at wave granularity.

---

## Wave 1 — VMX compiler + stored format

The foundation: parse the wire dialect, compile it to the canonical stored document, prove totality and id stickiness. Pure library code — no model, no renderer, no network.

**Tasks:**

- [ ] **1.1 v2 stored-format types.** Define the `vendo-genui/v2` payload (anchor-keyed expanded nodes, header decls for queries/state/actions, content-addressed modules incl. `kind: "pin"`, macro provenance, retained `vmx` text) in `packages/core`, registered behind the existing `UIPayload.formatVersion` dispatch alongside v1 (`packages/core/src/formats.ts`, sibling of `tree.ts`). Schemas, limits, and reserved-name rules follow the v1 pattern in `tree-limits.ts`. v1 types stay untouched.
- [ ] **1.2 VMX stream parser.** Tokenizer/parser for the spec §1.1 grammar: header-first ordering enforced, element-commit semantics (open-tag completion commits the element with final attributes), intrinsic/stdlib/host./gen. name spaces, attribute and expression forms (paths, `$state`, literals, the fixed pure fn whitelist: sum/count/min/max/uniq/format), island declarations. Streaming by construction: the parser consumes chunks and emits committed elements; no growing-buffer re-parse.
- [ ] **1.3 The compiler.** Model text in, canonical document out. Compiler mints all ids (short, semantic, position/role-derived anchors; the model never sees or writes ids on create); macro expansion hook (actual macros arrive in Wave 2 — Wave 1 ships the expansion interface plus 2–3 fixture macros for testing); expressions compile to v1-semantics JSON Pointer bindings; provenance recorded; authored VMX retained verbatim on the document.
- [ ] **1.4 Sticky anchors.** On recompile after an edit, align the new tree against the previous document and preserve anchors so grants, pins, and annotations survive. This is the hardest algorithmic piece in the wave — give it its own task, its own property tests, and adversarial cases (reorder, wrap, duplicate-looking siblings).
- [ ] **1.5 Repair ladder, layers 1/2/4.** Element-local containment: a parse or semantic failure becomes a `repair` node holding raw text plus a skeleton, and the stream continues; document invariants checked at stream end and fixed by targeted patch ops. Layer 3 (the model repair call) is interface-only here — an injectable seam so Wave 1 tests stay deterministic; Wave 3 wires the real call. Compilation is total: any stream prefix compiles to a valid smaller document; full regeneration is reserved for catastrophic stream loss.
- [ ] **1.6 Golden-file + property test suite.** A corpus of scripted VMX documents and chunked stream replays with expected compiled output committed as golden files (the Wave 2/3 renderer and pipeline reuse these fixtures). Property tests: every prefix of every fixture compiles valid; anchors stable across recompile of edited variants; malformed-element injection always yields a contained `repair` node, never a failed compile.

**Done when:** golden files and property tests green in CI; a fuzz pass over truncated/corrupted streams produces zero compile failures (only repair nodes); anchor-stickiness tests cover the adversarial set; typecheck/lint green.

**Deletes:** nothing (parallel build; v1 untouched).

---

## Wave 2 — Stdlib/macro tier + renderer/streaming

Two parallel tracks that meet in a browser: the macro tier that carries the measured 2.3x density and the zero-CLS geometry, and the v2 renderer that mounts the stream.

**Tasks (track A — stdlib/macros; needs 1.3's expansion interface):**

- [ ] **2.1 `@vendoai/stdlib` package v0.** ~20–30 entries per the accepted §7 Q1 scope: the corpus's repeat offenders (record table, metric row/grid, list-manage, detail header, create/edit form, chart family) as themed pre-audited components plus parameterized macros. Compiler expands macros into concrete nodes using host-registered components where available; resolution order host catalog > stdlib > generated enforced by the compiler; host registration rejects stdlib-colliding names (v1 reserved-name rule extended). Stored documents contain the expansion; the macro call is provenance (§7 Q2). Admission rule ("three unrelated corpus apps needed it") documented in the package README for future growth.
- [ ] **2.2 Density re-check.** Re-run the corpus token/density comparison on real corpus apps expressed in VMX+macros vs their v1 JSON: confirm the ~2.3x holds. If it lands materially below (<1.8x), escalate to Yousef before Wave 3 — the latency budget assumes it.

**Tasks (track B — renderer; needs 1.1–1.5):**

- [ ] **2.3 v2 renderer.** New render path in `packages/ui` beside the v1 tree renderer, selected by `formatVersion`: anchor-keyed targeted inserts as elements commit (no re-parse, no flush throttle), unclosed elements render committed children plus a skeleton tail, macro regions reserve geometry at expansion, `repair` nodes render as contained skeletons, `gen.` island nodes render labeled geometry-reserving skeletons until module arrival, island failure shows a contained error state (§7 Q5 — honest failure, purely decorative islands may drop). Binding/theme/guard chokepoints reuse the v1 machinery unchanged.
- [ ] **2.4 Prewarm + local launch skeleton.** At widget mount: boot the jail iframe from the cached runtime bundle and open the stream transport before any prompt exists. At submit: the deterministic local sketcher (no inference) paints the structure-only launch skeleton — branded chrome, plausible regions, real title words, never fake data (§3.1, accepted §7 Q4). Real `<app name>` replaces the sketched title on arrival.

**Done when:** browser-verified against scripted stream replays (the Wave 1 golden fixtures replayed at realistic chunk cadence): skeleton pixels well under 1s from submit with zero inference; measured cumulative layout shift ≈ 0 via a layout-shift observer across the full replay; progressive states screenshot-documented in the PR; every-prefix-renders-valid exercised in the browser, not just the compiler.

**Deletes:** nothing yet (v1 renderer remains the default for stored v1 apps).

---

## Wave 3 — Serving seam + hosted generation pipeline

The first end-to-end model-driven path: prompt in, live v2 app out, at the launch latency targets.

**Tasks:**

- [ ] **3.1 `GenerationServing` adapter.** The spec §4 interface: one declarative-document stream per request, one island-lane call per declared island, `capabilities()` for grammar/prefix-cache/speculative/session-KV. Ship the hosted adapter (frontier model behind a provider API) and a BYO adapter (grammar card in context, no capabilities). Owned-serving capabilities are declared and stubbed — the fast-follow claims them without touching format, compiler, or renderer. The pipeline consults capabilities and degrades feature-by-feature; correctness never depends on any capability.
- [ ] **3.2 Create pipeline.** Prompt assembly with a byte-stable prefix (catalog + theme + rules + grammar card first, user request last) to maximize provider prompt caching; single declarative stream through the Wave 1 compiler into the wire stream parts the Wave 2 renderer consumes; query declarations dispatch through the guard at element commit so host-API RTT overlaps decode; approval-needing calls surface the approval card while rendering continues with shimmer bound to that query.
- [ ] **3.3 Island lane.** Parallel generation call per declared island: code-tuned prompt given only the declared interface, theme token names, and the jail import allowlist; source travels raw (never JSON-escaped), compiles at arrival, splices into the painted app. Compiler policy rejects islands that reimplement a resolvable catalog/stdlib component (`reason` enum enforced). Same jail, no network, effects only through dispatch → renderer chokepoint → guard.
- [ ] **3.4 Repair lane, layer 3 live.** Wire the injectable repair seam to small hosted calls: failing element + neighborhood + machine diagnostic → one corrected element, two attempts then drop-and-log as a capability miss, always off the paint path.
- [ ] **3.5 Latency bench + fast-follow gate wiring.** Extend the corpus harness to run the bench task set end-to-end against the hosted adapter and record FMP and complete distributions per run. Wire in the fast-follow gate metrics (§7 Q7: constrained validity, FMP p95, complete p95, judge-eval quality) so the owned-serving switch is a measured decision later — the harness reports them from day one even though owned serving doesn't exist yet.

**Done when:** measured on the corpus bench tasks against the hosted adapter — FMP p50 ≈ 5s and complete p50 ≈ 30s (miss by >25% ⇒ escalate to Yousef with the breakdown rather than tuning silently); a real-browser end-to-end run (prompt → skeleton → streamed app → island hydration → guarded query with approval card) screenshot/GIF-documented in the PR; repair-lane behavior demonstrated by fault injection on a live run.

**Deletes:** nothing yet. The v2 path can ship dark or behind a flag; v1 create remains the default until Wave 5.

---

## Wave 4 — Edits, pins on islands, approvals threadId

One dialect for create and edit; repair, never regenerate; pins become representable inside the format.

**Tasks:**

- [ ] **4.1 Patch dialect.** Edit requests send instruction + the stored VMX with compiler anchors rendered inline (token-cheap, human-readable — no multi-thousand-token JSON resend); the model emits patch elements (`set` / `insert` / `remove` / `set-query`, payloads are ordinary VMX) through the same parser, compiler, and validation ladder. A bad patch line becomes a `repair` node fixed element-locally — the app is never regenerated. Recompile preserves anchors (Task 1.4 is the load-bearing dependency).
- [ ] **4.2 Patch log as version history.** Every applied patch is the version delta: undo is patch reversal, history is the patch log, storage is canonical document + patch history (no op-log-as-source-of-truth). Only fully validated documents persist; on-screen progressive state is preview.
- [ ] **4.3 Repair-ladder layer 5 (binding audit).** After first real query results, audit bound paths against the actual response shape; emit fixes as ordinary patches through the 4.1 channel. (Deliberately deferred from Wave 3 because it needs the patch channel.)
- [ ] **4.4 Direct manipulation hook.** The client maps every DOM region to its anchor; click-to-edit sends instruction + focused anchor and scopes the patch to that subtree. Browser-verified.
- [ ] **4.5 Pins ride the islands.** A host-component fork under rehearsal becomes a module of `kind: "pin"` (`slot`, `baseHash`, `source`) referenced from the node that used `host.X`, riding the same island compile/render machinery in the jail; pin edits are ordinary 4.1 patches against that module. Ship computes the net diff from `baseHash` with unchanged shapes (`PinShipRequest`, `PinApproval`); the approved copy lives in the host registry and mounts natively; the `pins` field and export rules (fail, never strip) carry over verbatim. Existing pin behavior (capture, rehearse, diff-approve, drift+rebase) is the acceptance bar — `pins.test.ts` / `rebase.test.ts` scenarios must pass re-expressed against v2.
- [ ] **4.6 `threadId` on ApprovalRequest.** Add the `threadId` field to `ApprovalRequest` (`packages/core/src/grants.ts`) and plumb it through guard, wire, and UI surfaces that raise or render approvals (PR #353 backlog item — this wave touches the approval-in-stream flow, so it lands here).

**Done when:** browser-verified edit loop (instruction → patch → in-place update with anchors stable, plus click-to-edit scoping) with screenshots; hosted edit latency measured in seconds, not tens of seconds, on the bench edit tasks; pins end-to-end (capture → rehearse as pin module → patch-edit → ship diff → native mount) green; undo/history behavior covered by tests; approval flows carry `threadId` end to end.

**Deletes:** nothing yet (final cut is Wave 5, after the up-converter makes v1 apps reachable from v2).

---

## Wave 5 — v1→v2 up-converter + the deletions

Make every stored v1 app reachable from the v2 engine, flip the default, then take the kill-list cuts this rebuild owns.

**Tasks:**

- [ ] **5.1 v1→v2 up-converter.** Mechanical, total conversion (v1 is strictly less expressive): v1 tree/queries/state/actions → v2 document with compiler-minted anchors; v1 generated-code components → island modules; pinned components → `kind: "pin"` modules. Convert on first edit; keep the v1 renderer through the rollout window only, with a dated removal ticket — not forever. Golden tests over a sweep of real stored apps and corpus fixtures; converted apps must render identically (screenshot comparison on the demo hosts). The converter also doubles as the fine-tune corpus bootstrapper for the owned-serving era — emit converted VMX to a corpus directory as a byproduct.
- [ ] **5.2 Flip the default.** v2 pipeline becomes the create/edit path in the umbrella and demo hosts; v1 generation is unreachable. Demo hosts (Maple, Cadence) verified in a real browser.
- [ ] **5.3 Cut A1 — sandbox fork/swap/snapshot/resume (~800 lines).** `packages/apps/src/machine.ts` (entire file), the fork→build→probe→snapshot→swap edit path and snapshot-serving POSIX snippets in `runtime.ts`, the rung-4 resume/cover path in `open.ts`, and `run-token-gate.ts` (run token shrinks to a static per-run secret). Interchange keeps export/import but loses its machine-resume legs.
- [ ] **5.4 Cut A2 — edit dialects + tree-op interpreter (~480 lines).** `applyTreeOps`, the tree-vs-code dialect router regexes, and the duplicated two-attempt full-regeneration repair loops in `engine.ts` and `runtime.ts`; then the v1 `modelEngine` generation path itself once nothing dispatches to it.
- [ ] **5.5 Cut A3 — `incremental-tree.ts` (269 lines).** The hand-rolled streaming-JSON parser and its markdown-fence stripping, plus its tests and the engine's imports of it.
- [ ] **5.6 Sweep.** Remove v1-only prompts, fixtures, and dead exports orphaned by 5.3–5.5 (a dead-code pass over `packages/apps` and `packages/ui`); update `docs/` integration docs to describe the v2 engine; report the net line delta in the PR.

**Done when:** full monorepo suite green (`pnpm build && pnpm test && pnpm typecheck && pnpm lint`, dependency-guard included); corpus harness green end-to-end on v2; zero remaining references to `machine.ts`, `applyTreeOps`, or `incremental-tree`; demo hosts browser-verified on the v2 path with screenshots; up-converter sweep results (count converted, count identical-render) in the PR.

**Deletes:** kill-list A1, A2, A3 in full, plus the v1 generation path — the ~1,550 condemned lines and their tests.

---

## Risk register (top 5)

1. **Hosted latency targets don't reproduce in production conditions.** The ~5s FMP p50 came from benchmark conditions; provider TTFT variance, prompt-cache misses (any prefix byte-instability silently kills the biggest lever), and slow host APIs can blow the budget. Mitigation: byte-stability asserted by test in Wave 3; bench gate measured on the corpus harness with p95s reported, not just p50s; escalation rule instead of silent tuning. **This is the plan's riskiest assumption.**
2. **Sticky-anchor alignment is subtly wrong.** Grants, pins, and annotations reference anchors; a misalignment on recompile silently re-points authority or breaks pins. Mitigation: dedicated task (1.4) with adversarial property tests; Wave 4's pin suite doubles as an integration check; anchors are load-bearing for every later wave, so Wave 1 does not exit without them proven.
3. **Macro tier under-delivers.** The 2.3x density and 0-CLS results both live in the macro tier; if the launch ~20–30 entries don't cover real corpus apps, generation falls back to element-by-element output — slower, shiftier, blander. Mitigation: density re-check gate (2.2) with an explicit escalation threshold; capability-miss telemetry from Wave 3 feeds admission.
4. **Repair-lane economics at 96.3% validity.** Element-local repair adds a hosted-call tail; the two-attempts-then-drop policy can visibly degrade apps if failures cluster (e.g. one systematic prop mistake across a whole document). Mitigation: repair is off the paint path by construction; fault-injection tests in Wave 3; capability-miss logging makes clustering measurable before it's a user complaint.
5. **The up-converter's "total mapping" claim meets a real app that doesn't map.** v1 generated-code components, machine-backed apps built under the old 4-rung ladder, and pins interact in ways a mechanical converter may miss — and Wave 5's deletions are irreversible once merged. Mitigation: converter ships and is swept over all stored apps + corpus fixtures with render-identity screenshots *before* any A1/A2/A3 line is deleted; rollout window keeps the v1 renderer until the sweep is clean.

---

## Non-goals (spec §6, binding)

- **No multi-lane orchestration of the declarative document.** One stream owns coverage; the only parallel lane is code islands.
- **No 4-rung ladder.** No invisible graduation, fork-build-probe-swap, or resume covers; escalation is an engine judgment, not a format tier.
- **No new expression language.** `{…}` stays paths + the small fixed pure whitelist; anything Turing-shaped is an island.
- **No binary/opcode wire encodings** as the model channel.
- **No sketch/retrieval caches as a launch dependency.** Launch first paint is the deterministic local skeleton + macro-first ordering; retrieval drafting is owned-serving-era.
- **No CRDT/op-log storage.** Canonical document + patch history only.

Additionally out of scope for this plan: owned serving itself (the fast-follow claims the stubbed capabilities when the §7 Q7 gate metrics hold), the VMX naming bikeshed (deferred by decision Q8), and any contract-doc maintenance (the contracts system is retired).
