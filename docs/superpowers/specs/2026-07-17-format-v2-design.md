# Format v2 — the generation format and pipeline

Date: 2026-07-17
Status: DRAFT for Yousef's review (format-gen-v2 lane of the microapps v2 overhaul)
Merge point: pairs with the simplify-v2 kill-list (`2026-07-16-simplify-v2-kill-list-design.md`); together they feed the v2 contract re-derivation. Contracts are unfrozen; breaking changes are allowed.

Inputs, in order of authority:

1. **Benchmark verdicts (decided, not relitigated here):** Fork 1 — the JSX-like
   markup wire format won (best first-paint and quality, zero cumulative layout
   shift; 96.3% structural validity unconstrained, to be closed to ~100% with
   grammar-constrained decoding once owned serving exists). Fork 3 — the
   macro-first pipeline won (first-meaningful-paint p50 4.9s vs 17.1s
   single-stream). Multi-lane orchestration was a **negative result** — coverage
   collapses — and is excluded (§6). Measured density gain comes from the
   macro/stdlib compression tier, ~2.3x over v1 — not from syntax.
2. **Decisions locked by Yousef (2026-07-17):** v2 launches on hosted inference
   (~5s first paint / ~30s complete at launch); the contracts carve an
   owned-serving seam claimed by a fast-follow (prewarm + speculative decoding +
   grammar constraints → <1s / <10s); model output ≠ stored format (a compiler
   owns ids and normalization); edit is repair-not-regenerate, one dialect for
   create and edit; code islands ride a separate lane from the declarative
   catalog markup; pins survive into v2; first paint must not wait on the main
   model.
3. The prior-art survey (`docs/research/2026-07-16-genui-prior-art.md`, branch
   `yousefh409/genui-prior-art-research`) and the four ideation docs (branches
   `yousefh409/format-v2-ideas-{fable-a,fable-b,codex-a,codex-b}`). Where they
   conflict with the benchmarks, the benchmark wins; §8 records each such call
   in one line.

Baselines and targets:

| | first meaningful paint | complete |
| --- | --- | --- |
| v1 measured | 63–103s | 90–145s |
| **v2 launch (hosted inference)** | **~5s p50** | **~30s p50** |
| v2 fast-follow (owned serving) | <1s | <10s |

---

## 1. The wire format: VMX (`vendo-genui/v2` wire dialect)

The model emits **VMX** (working name — Vendo markup): a JSX-like markup
dialect. It is what the benchmark's Fork 1 measured: familiar to every model's
pretraining prior (the decisive quality lever the line-DSL forks lacked),
element-streamable, and zero-CLS when paired with macro geometry. It is a
*wire* dialect only — it is compiled, never stored raw as the app's canonical
form (§2), though the authored text is retained verbatim for edits (§5).

### 1.1 Grammar sketch

```
document   := <app name="…"> header* body island-decl* </app>
header     := <query id tool|fn args…/> | <state id initial=…/> | <action id call=… args… confirm? refresh=…/>
body       := element*
element    := <Name attr*> element* </Name> | <Name attr*/> | text
Name       := intrinsic                     — lowercase layout: col row grid card text divider spacer
            | PascalCase                    — Vendo stdlib component or macro (§1.4)
            | host.PascalCase               — host catalog (brand fidelity wins resolution)
            | gen.PascalCase                — code-island component declared in this document (§1.3)
attr       := key="string" | key={expr} | key            — bare key = boolean flag
            | on:event={action-id}                       — event wiring, by declared action id
expr       := data path (invoices.items, row.total)      — compiles to v1-semantics JSON Pointer bindings
            | $stateId                                   — client view state
            | JSON literal
            | fn(expr…) from a small fixed whitelist     — sum, count, min, max, uniq, format (§7 Q3)
island-decl := <island id props-schema reason fallback?/>  — declaration only; source rides the island lane (§1.3)
```

The grammar is deliberately header-first: `<app>`, then all `query`/`state`/
`action` declarations, then the body. This is the macro-first ordering rule the
benchmark validated — the renderer has the app's name, its data intents, and
its skeleton before any body detail decodes, and queries dispatch through the
guard while the body is still streaming.

### 1.2 The same app, by example

```jsx
<app name="Overdue Invoice Chaser">
  <query id="invoices" tool="host_invoices_list" status="overdue" limit={50}/>
  <state id="selected" initial={null}/>
  <action id="remind" call="host_invoices_send_reminder" invoiceId={row.id} confirm refresh="invoices"/>

  <MetricRow>
    <host.StatCard label="Total overdue" value={invoices.summary.total} format="currency"/>
    <host.StatCard label="Count" value={invoices.summary.count}/>
  </MetricRow>
  <RecordTable rows={invoices.items} select={$selected} on:rowAction={remind}
               fields={["number","customer","dueDate","total"]}/>
  <text muted>Reminders send as you, with approval.</text>
</app>
```

`MetricRow` and `RecordTable` here are stdlib macros (§1.4) — this document is
~140 tokens where the v1 equivalent is ~650. The compression is the macros, not
the angle brackets: the same app spelled element-by-element in VMX is only
modestly smaller than v1 JSON. That is the benchmark's density finding
(~2.3x over v1, macro tier included) and it sets honest expectations —
density is one lever among several, not the whole latency story.

What carries over from v1 unchanged: binding semantics (`{invoices.items}`
compiles to the same JSON Pointer `$path` model, `$selected` to `$state`),
the guard chokepoint for every callable, `fn:` references for app-machine
functions, theme tokens, and the one security rule — **the format never
carries authority**. VMX text is inert data; every call is guard-checked at
dispatch, not at generation.

### 1.3 Code islands: declared in markup, delivered on a separate lane

Locked decision: island source does not interleave with the declarative
stream. The markup only *declares* the island:

```jsx
<island id="AgingChart" props='{"series":"array"}' reason="novel-visualization"/>
…
<gen.AgingChart series={invoices.items}/>
```

The island's TSX source is produced by a **parallel generation call on the
island lane** — a code-tuned prompt given only the island's declared interface,
theme token names, and the jail's import allowlist. Source travels raw (never
JSON-escaped — the single biggest v1 validation-failure class), is compiled at
arrival (5–20ms), and splices into an already-painted app; `gen.` nodes render
as labeled, geometry-reserving skeletons until then. Islands never block first
paint or the declarative stream.

This is *not* the multi-lane orchestration the benchmark rejected: the
declarative document — everything that determines coverage — is one stream.
The island lane is a Yousef-locked carve-out for code only, and an island that
fails or times out degrades one region, not the app.

`reason` is a small enum (`novel-visualization`, `custom-interaction`,
`no-catalog-match`, `server-computation`); the compiler rejects an island that
merely reimplements a resolvable catalog/stdlib component, making
"prefer the host catalog" a compiler policy rather than prompt prose.
Security is unchanged from v1: same jail, no network, effects only through the
injected dispatch prop → renderer chokepoint → guard.

### 1.4 The macro/stdlib tier (where the measured density lives)

Vendo ships `@vendoai/stdlib`: themed, pre-audited components plus
**macros** — parameterized structural elements (`RecordTable`, `MetricRow`,
`ListManage`, `DetailHeader`, `FormCreateEdit`, …) that the compiler expands
into concrete catalog/prewired nodes using the host's registered components
when available. One 20–40 token macro element yields ten to twenty branded
nodes with predictable anchors and reserved geometry (the zero-CLS mechanism).

Rules:

- Resolution order is host catalog > stdlib > generated, enforced by the
  compiler and by fine-tune reward later. Host registration rejects
  stdlib-colliding names (v1's reserved-name rule, extended).
- Macros are compiler instructions, not opaque runtime behavior: the stored
  document contains the **expanded** nodes (every part stays editable, edits
  stay anchor-addressed), with the originating macro call recorded as
  provenance metadata (§7 Q2).
- Stdlib admission is corpus-driven: a component or macro enters when three
  unrelated corpus apps needed it. Start small (~20–30 entries), grow from
  capability-miss telemetry — not fable-a's ~80 up front (§7 Q1).

---

## 2. The compile step: model output ≠ stored format

A deterministic, total compiler sits between the model stream and everything
else. The model writes VMX; nobody else ever consumes raw model text.

### 2.1 The stored document

The compiler produces the canonical `vendo-genui/v2` payload, registered
behind the existing `UIPayload.formatVersion` dispatch (01-core §8) — the app
document envelope, wire routes, `fn:`, storage, and grants are untouched:

```ts
interface TreeV2 {
  formatVersion: "vendo-genui/v2";
  root: NodeId;
  nodes: Record<NodeId, NodeV2>;         // anchor-keyed, expanded (macros resolved)
  queries: QueryDecl[];                  // v1 semantics, declared in the header
  state: Record<string, Json>;
  actions: Record<string, ActionDecl>;   // named, guard-checked at dispatch
  modules: Record<string, ModuleV2>;     // content-addressed island sources (+ kind: "pin", §5.3)
  provenance?: { macros?: MacroCall[] }; // which macro produced which anchors
  vmx: string;                           // the authored wire text, kept verbatim (edit context, human diffs)
}
```

### 2.2 Id ownership

**The compiler owns identity; the model never mints ids.** Anchors are short,
semantic, compiler-stamped (derived from macro role / component / position —
`page`, `metrics.total`, `results`), unique per document, and **sticky**: on
recompile after an edit, ids are preserved by tree alignment against the
previous document, so grants, pins, and annotations that reference nodes
survive edits. On create the model sees no ids at all; on edit it sees them as
anchors (§5.1). Prior art is unanimous here (A2UI, Flight, CHAOS, all four
ideation docs), and it removes both the id-token tax and the duplicate-id
failure class.

### 2.3 Validation and the repair loop

Validation is element-local and continuous, not post-hoc and all-or-nothing:

| layer | when | on failure |
| --- | --- | --- |
| 1. parse | per element, as the stream commits | element becomes a `repair` node holding raw text + a skeleton; stream continues |
| 2. semantics | per element | component resolves (host trie / stdlib / declared `gen.`), props validate against the registered schema, callables exist, binding paths well-formed → else `repair` node |
| 3. targeted repair | per `repair` node, off the paint path | one small model call: the failing element + its neighborhood + the machine diagnostic → one corrected element. Two attempts, then drop the node and log a capability miss |
| 4. document invariants | at stream end | root non-empty, references closed, island declarations matched → fixed by targeted patch ops, never regeneration |
| 5. binding audit | after first query results | do the bound paths exist in the *actual* response shape? Fixes emitted as ordinary edit patches (§5) |

Compilation is **total**: any stream prefix compiles to a valid (smaller)
document, and a malformed element is a contained node-local state. Full
regeneration is reserved for catastrophic stream loss. This deletes v1's
2-attempt full-regeneration loop (already condemned by the kill-list, A2/A3)
and its economics: v1 pays the whole app per failure; v2 pays an element.

At launch the unconstrained validity rate is the benchmark's 96.3% — layers
1–3 absorb the gap. When owned serving lands, grammar-constrained decoding
makes layers 1–2 unrepresentable-by-construction and the repair lane goes
quiet; it stays in place because constrained decoding's compliance ceiling is
real (JSONSchemaBench: ~96% even on easy schemas) and BYO mode never has
constraints.

---

## 3. Streaming: first paint before the main model

Three mechanisms, in the order they hit the screen:

### 3.1 The prewarmed surface (no model, no network)

At widget mount — before any prompt exists — the client boots the jail iframe
from the cached runtime bundle (renderer + stdlib + host catalog bundle +
theme vars) and opens the stream transport. This is 300–800ms of cost paid
while the user is still typing. At submit, the surface opens around an
already-live jail; a deterministic local sketcher (no inference) extracts
title words and an archetype from the prompt and paints a **structure-only
launch skeleton**: branded chrome, plausible regions, real title text, never
fake data. This is what "first paint must not wait on the main model" means at
launch: pixels at ~300–500ms from local work, truth streaming in behind them.

### 3.2 Macro-first ordering (the Fork 3 win)

The grammar forces header-then-body (§1.1) and the prompt/fine-tune forces
macro elements before element-by-element detail. Consequences, in stream
order:

1. `<app name>` — real title replaces the sketched one.
2. `query` lines — dispatched through the guard **at element commit**, so host
   API RTT (100–600ms) overlaps the rest of decode; approval-needing calls
   surface the approval card while rendering continues with shimmer bound to
   that query.
3. Macro elements — each expands instantly into a full branded region with
   reserved geometry. This is the measured FMP mechanism: p50 4.9s on hosted
   inference vs 17.1s for the v1-shaped single stream.
4. Detail elements and overrides fill in; `gen.` skeletons hydrate when the
   island lane delivers.

### 3.3 Progressive mount semantics

Element commit is defined by the grammar, not by JSON heroics: an element
mounts when its open tag completes (`>` or `/>`), with attributes final at
that point; children stream into it; unclosed elements at any instant render
their committed children plus a skeleton tail. Every stream prefix is a valid
smaller app (§2.3). The renderer applies commits as targeted inserts keyed by
anchor — no re-parse of a growing buffer, no 100ms flush throttle, no
`IncrementalTreeParser` (kill-list A3). Layout shift is bounded by macro
geometry: regions reserve their size at expansion, so late content fills
rather than reflows — the benchmark's 0-CLS result.

`done` carries the canonical document hash; only a fully validated document is
stored. The on-screen progressive state is preview, never persistence.

---

## 4. The serving seam: hosted now, owned later as a config swap

The contract carves generation serving into an adapter so the fast-follow
claims the owned stack without touching the format, compiler, or renderer:

```ts
interface GenerationServing {
  /** One declarative-document stream per request; one island-lane call per declared island. */
  streamDocument(req: DocumentRequest): AsyncIterable<string>;   // VMX text chunks
  generateIsland(req: IslandRequest): Promise<string>;           // raw TSX source
  capabilities(): {
    grammar?: CompiledGrammar;      // owned serving: logit-mask constrained decoding from the VMX grammar + host tables
    prefixCache?: "provider" | "pinned-kv";  // hosted: provider prompt caching; owned: per-host pinned KV prefix
    speculative?: boolean;          // owned serving: n-gram/EAGLE-class drafting
    sessionKv?: boolean;            // owned serving: app context stays resident between edits
  };
}
```

- **Launch (hosted):** a frontier model behind a provider API. The pipeline
  uses provider prompt caching with a byte-stable prefix (catalog + theme +
  rules + grammar card first, user request last — the single biggest hosted
  TTFT lever, up to ~85% reduction per provider docs), single document
  stream, island lane as parallel API calls, repair via small hosted calls.
  Targets: ~5s FMP / ~30s complete.
- **Fast-follow (owned):** same interface, capabilities filled in. Grammar
  constraints close the 96.3%→100% validity gap and fast-forward structural
  tokens; pinned per-host KV prefixes delete prefill; speculative decoding
  (structured markup is its best case) multiplies decode; a fine-tuned
  mid-size model replaces the frontier call. Targets: <1s / <10s.
- **BYO/OSS:** the same dialect via an in-context grammar card, no
  capabilities, published as best-effort. The format is identical in all three
  modes — capability tiers, not divergent designs.

The pipeline consults `capabilities()` and degrades feature-by-feature;
correctness never depends on any capability (e.g. session KV eviction falls
back to re-prefilling the stored `vmx` text, which is cheap by construction).

---

## 5. Edit semantics: one dialect, repair not regenerate

### 5.1 The patch grammar is the create grammar

Create is the degenerate edit against an empty document. For edits, the model
receives the stored `vmx` text with compiler anchors rendered inline
(`<host.StatCard #m2 …>`) — token-cheap, human-readable — and emits patch
elements whose payloads are ordinary VMX:

```jsx
<patch>
  <set at="#m2" label="Total overdue (30d)"/>
  <insert after="#m2">
    <host.StatCard label="Disputed" value={invoices.summary.disputed}/>
  </insert>
  <remove at="#t9"/>
  <set-query id="invoices" status="all"/>
</patch>
```

One dialect means: same element grammar, same attribute/expression forms, same
compiler, same validation ladder — a bad patch line becomes a `repair` node
exactly like a bad create line, fixed element-locally, never by regenerating
the app. v1's second dialect (JSON tree-ops against a resent document) and its
dialect router die with kill-list A2.

Direct manipulation falls out: the client knows the anchor behind every DOM
region, so click-to-edit sends instruction + focused anchor and scopes the
patch to that subtree. Every applied patch is the version delta: undo is
patch reversal, history is the patch log, and the binding-audit and polish
passes (§2.3 layer 5) emit their fixes through this same channel.

### 5.2 Edit latency

Hosted launch: instruction + anchored `vmx` context (hundreds of tokens, not
v1's multi-thousand-token JSON resend) + provider prompt cache → seconds.
Owned fast-follow: session-KV-resident app context → sub-second, which is the
point where editing stops feeling like requests and starts feeling like
direct manipulation.

### 5.3 Pins survive

Pins remain exactly the app-format-spec §5 flow (opt-in capture, conversational
fork rehearsed in the jail, diff-against-baseline approval, host-registry
hash-pinning, drift + rebase). What v2 adds is representability inside the
format:

- A host-component fork under rehearsal is a module of kind `"pin"`:
  `{ kind: "pin", slot, baseHash, source }` in `modules`, referenced from the
  node that previously used `host.X` — so the fork rides the same island
  compile/render machinery in the jail, and pin edits are ordinary §5.1
  patches against that module.
- Shipping computes the net diff from `baseHash` (unchanged contract shapes:
  `PinShipRequest`, `PinApproval`); the approved copy still lives in the host
  registry and mounts natively. The document's `pins` field and export rules
  (fail, never strip) carry over verbatim.

---

## 6. Non-goals

- **Multi-lane orchestration of the declarative document.** Benchmarked
  negative: fanning the app's coverage across parallel decoders collapses
  coverage. fable-b's five-lane pipeline, its parallel region decoders and
  separate planner model, and codex-a/b's architect+draft lane topologies are
  all out. One stream owns the declarative document; the only parallel lane is
  code islands (locked decision, §1.3).
- **The old 4-rung ladder.** The rung choreography (invisible graduation,
  fork-build-probe-swap, resume covers) is gone per the kill-list and the
  one-machine-per-app decision. v2 has the instant jailed plane plus an
  optional app machine reached by `fn:`; escalation is an engine judgment, not
  a format tier the document encodes.
- **A new expression language.** `{…}` stays paths + a small fixed pure
  whitelist (§7 Q3). Anything Turing-shaped is an island.
- **Binary/opcode wire encodings** (SceneTape control tokens, CBOR framing as
  the model channel). The benchmark chose readable markup; binary transport
  destroys model prior and debuggability for bytes that aren't the bottleneck.
- **Sketch/retrieval caches as a launch dependency** (fable-b Lane A, codex-a
  launch packets). The local deterministic skeleton (§3.1) covers
  paint-before-model at launch; retrieval drafting is an owned-serving-era
  optimization, not spec'd here.
- **CRDT/op-log storage.** Storage is canonical document + patch history —
  no Yjs-class machinery.

---

## 7. Open questions for Yousef

Each with a recommendation; none block starting the compiler + renderer.

1. **Stdlib/macro launch scope.** How many entries at launch? —
   **Recommend:** start ~20–30 (the corpus's repeat offenders: record table,
   metric row/grid, list-manage, detail header, create/edit form, chart
   family), admission rule "three unrelated corpus apps needed it," grow from
   capability-miss telemetry. The 2.3x density number came from this tier, so
   under-scoping it under-delivers the benchmark win; over-scoping is a
   maintenance sink and a blandness risk.
2. **Store macro expansion or macro call?** — **Recommend:** store the
   expansion, record the macro call as provenance (§2.1). Edits stay
   anchor-addressed against concrete nodes, and a stdlib macro changing later
   can't silently restyle stored apps. Cost: stored docs are bigger and a
   "re-expand with newer macro" upgrade needs explicit tooling.
3. **Expression whitelist size.** Paths-only, or paths + a small pure set
   (`sum count min max uniq format`)? — **Recommend:** ship the small set.
   Corpus evidence says a large share of v1's generated components exist only
   to compute an aggregate or format a date; killing those islands is the
   cheapest safety and latency win available. Constitution: pure, total,
   bounded, no user-defined functions — anything more is an island.
4. **Local launch skeleton at v2 launch, or fast-follow?** With hosted FMP at
   ~5s, the pre-model skeleton (§3.1) is the only thing on screen for the
   first seconds. — **Recommend:** ship the minimal version at launch
   (deterministic archetype + title extraction, structure-only honesty rule);
   it is client-side work with no inference dependency, and it is what makes
   "first paint doesn't wait on the model" true on day one.
5. **Island failure policy.** After two failed repairs: drop to a declarative
   fallback region, or fail the generation honestly? — **Recommend:** honest
   failure with the last valid app retained and the island's region showing a
   contained error state; silent feature-dropping is the worse product lie.
   (Purely decorative islands may drop.)
6. **v1 migration moment.** Renderer-forever vs lazy up-conversion? —
   **Recommend:** since contracts are unfrozen and stored-app volume is small,
   ship a mechanical v1→v2 up-converter (v1 is strictly less expressive; the
   mapping is total), convert on first edit, keep the v1 renderer through the
   rollout window only — not forever. The converter doubles as the fine-tune
   corpus bootstrapper for the owned-serving era.
7. **Fast-follow gate.** What flips the owned-serving switch? —
   **Recommend:** a measured gate on the corpus harness: grammar-constrained
   validity ≥99.5%, FMP p95 <1.2s, complete p95 <10s, quality non-inferior to
   the hosted frontier baseline by judge eval. Until all four hold, hosted
   stays the default even if owned serving is cheaper.
8. **Naming.** "VMX" is a working name for the wire dialect; the stored tag
   `vendo-genui/v2` is the real identifier. — **Recommend:** bikeshed once at
   contract re-derivation, not before.

---

## 8. Conflict log (ideation docs vs the verdicts)

One line each, per the drafting mandate:

- **Line-oriented indentation DSLs (fable-a VML, fable-b VNL) → rejected:**
  Fork 1 measured JSX-like markup as best on paint *and* quality — the
  pretraining prior beat the token-count argument, and the density the DSLs
  promised (5–15x) did not materialize from syntax (~2.3x, macro-driven).
- **Opcode/transaction streams (codex-a SceneTape, codex-b ops+CBOR) →
  rejected as the model wire:** same benchmark reason, plus non-goal on binary
  encodings; their compiler-owns-ids, model-output≠storage, and
  sealed-region-honesty ideas are adopted (§2, §3.3).
- **Parallel region decoders / five-lane pipelines (fable-a §4.4, fable-b §5,
  codex-a lanes C/D, codex-b architect+draft) → rejected:** multi-lane
  orchestration benchmarked negative (coverage collapses); only the code-island
  lane survives, by locked decision.
- **Sketch/retrieval cache as the FMP mechanism (fable-b Lane A, codex-a
  launch packet) → deferred:** launch FMP comes from the deterministic local
  skeleton + macro-first ordering; retrieval drafting is owned-serving-era.
- **Op-log as the storage format (fable-a §2.5) → narrowed:** patches are the
  version history, but the canonical artifact is the compiled document, not a
  replayable log.
- **Capability manifests on islands (fable-b `uses(…)`) → adopted in spirit:**
  the island declaration's props schema + declared actions is the minimization
  surface; the jail remains the boundary.
- **Fenced code inline in the create stream (fable-a §2.3, fable-b §2.3) →
  rejected:** locked decision puts island source on a separate lane; the
  markup carries only the declaration.

## 9. What gets built first (sequencing sketch, not a plan)

1. The VMX grammar + total compiler + `vendo-genui/v2` renderer, proven
   against scripted streams: any prefix renders valid, zero CLS, anchors
   sticky across recompiles.
2. Macro/stdlib tier v0 (the ~20–30 list) + the corpus token/density benchmark
   re-run to confirm the 2.3x holds on real apps.
3. Hosted pipeline: prefix-stable prompt + prompt caching + element-commit
   streaming + repair lane + island lane; measure the ~5s/~30s launch targets
   on the corpus harness.
4. Edit dialect + pins-as-modules + v1 up-converter.
5. The serving seam adapter, with the owned-serving capabilities stubbed and
   the fast-follow gate metrics wired into the harness.
