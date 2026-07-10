# Module Generation Speed — Research & Recommendations (July 2026)

How to make module generation and editing FAST across our three tiers:
Tier 1 `view.json` (declarative host-component tree, instant render), Tier 2
`index.tsx` (esbuild-bundled React in the sandboxed MCP-Apps iframe), Tier 3
micro-apps (Nixpacks-built server code in E2B/microVM sandboxes). Two clocks
matter: **time-to-first-render** of a new module and **edit-turnaround**.

Researched 2026-07-10 (web sources cited per section; numbers are the sources'
claims, marked UNVERIFIED where we could not confirm against a primary source).
Existing in-repo art this builds on, not redoes:

- **Remix fast edits** (spec 2026-07-04, PR #44): `edit_view` line-hunk deltas
  against a server-held normalized baseline (`packages/vendo-runtime/src/remix/
  baseline.ts`, `hunks.ts`, `edit-view-tool.ts`), coordinate-mode hunks, prepared
  sandbox-ready baselines. Result: first remix 32s → 4.4s, pin edits ~6s. The
  core insight — *the model should only type what changed, the server owns the
  rest* — generalizes to everything below.
- **Import-map vendoring** (`packages/vendo-stage/src/stage-host.ts`): react/
  react-dom/heavy deps served as blob modules via an injected importmap, so
  generated code never bundles React and compile input stays one small file.
- **MCP Apps protocol** (docs/specs/research-2026-07-framework-landscape.md §4):
  the spec already defines `ui/notifications/tool-input-partial` — streaming
  tool args into the iframe with best-effort JSON repair — i.e. the standard
  anticipates stream-rendered UI.

## TL;DR — top 10 ranked recommendations

Ranked by (expected win × confidence) / implementation cost.

| # | Recommendation | Tier(s) | Expected win | Cost |
|---|---|---|---|---|
| 1 | **Stream-render `view.json` as it generates** — incremental JSON parse, paint the tree top-down during the stream | 1 | first paint ~1s instead of after full generation (10–30s feel → ~1s feel) | S |
| 2 | **Prompt-cache the generation prompt** (system prompt + component catalog + module examples behind a cache breakpoint) | all | up to 85% TTFT cut on long prompts; 90% input-cost cut on reads | S |
| 3 | **Fast-provider lane for draft generation** — Cerebras/Groq/Fireworks-class serving (500–2,600 tok/s) for view.json and first-draft code; frontier model only where quality demands | all | 5–20× raw generation wall-clock | M |
| 4 | **Generalize hunk edits to all tiers + fast-apply merge** — model emits abbreviated edits; Morph-style apply model (10.5k tok/s) or OpenAI Predicted Outputs (3–5×) materializes full files | edit loop, 2–3 | multi-file edits at Tier-1-edit speed; per-file 70s→20s class wins | M |
| 5 | **Progressive capability: view.json first, upgrade in background** — every module renders a Tier-1 approximation instantly; Tier 2/3 build swaps in when ready | 1→2→3 | perceived TTFR = Tier 1 always (~1–2s), regardless of final tier | M |
| 6 | **Small-model routing/cascade** — small fast model classifies tier + emits view.json; big model reserved for code tiers | 1, routing | latency win on the (majority) Tier-1 path; 45–85% cost cut precedent | M |
| 7 | **Compile-as-you-stream + HMR-patch the live iframe** — esbuild transform per file as it closes in the stream; edits hot-swap the module instead of remounting the stage | 2 | compile off the critical path (~ms anyway); edit repaint without iframe reload, state preserved | M |
| 8 | **Warm pool + pause/resume snapshots for the server tier** — pre-booted Nixpacks base sandboxes; pause built modules, resume in ~1s (E2B) instead of rebuild/reboot | 3 | re-open of an existing module: minutes → ~1s; first-run: build hidden behind pool | M |
| 9 | **V8-isolate middle tier for JS-only server code** — Dynamic-Workers-style isolate (or self-hosted workerd/Deno) between iframe and microVM | 3 | ~5ms starts vs 150–800ms microVM boots; ~100× memory efficiency | L |
| 10 | **Module retrieval as prepared baselines** — retrieve similar accepted modules, seed them as the edit base so "new" modules are edits, not generations | all | our own 32s→4.4s precedent, applied to first-generation | M–L |

Cross-cutting finding: **constrained decoding is ~free and helps** (<40–50µs/
token overhead, kills retry loops) — always constrain `view.json`. And the
single biggest lever overall is #4+#10 combined: make as much of the pipeline
as possible an *edit of something that already exists* rather than open-ended
generation.

---

## 1. Fast LLM inference for generation

**Throughput-optimized providers are now 5–20× faster than frontier-lab
endpoints.** Artificial Analysis measured Cerebras serving Kimi K2.6 (a leading
open-weight coding model) at **981 output tok/s** — a 10k-token response in
5.6s vs 163.7s on the official Moonshot endpoint (29×). Cerebras publishes
2,600 tok/s on Llama 4 Scout and ~3,000 tok/s on gpt-oss-120B; Groq serves
Llama 3.3 70B at 250+ tok/s, Llama 4 Maverick at 1,200+ tok/s, small models at
500–2,800 tok/s. Typical GPU-served frontier models run ~50–200 tok/s.
([Cerebras](https://www.cerebras.ai/blog/cerebras-kimi-k2-Enterprise),
[General Input measurement](https://www.generalinput.com/blog/cerebras-kimi-k2-6-inference-speed-generative-ui),
[Groq](https://groq.com/lpu-architecture))

**Speculative decoding is productized, not exotic.** Vercel's v0 uses
Fireworks' n-gram-draft "Adaptive Speculation" (deterministic n-gram model
proposes tokens, the LLM verifies in parallel) plus RFT: their autofixer runs
at **8,130 char/s vs 238.9 for GPT-4o-mini (~34×)** with 93.87% error-free
generation, and the end-to-end pipeline claim is 40×.
([Fireworks/Vercel](https://fireworks.ai/blog/vercel)) OpenAI **Predicted
Outputs** is the same idea with the *caller* supplying the draft — pass the
current file as `prediction`, matching spans are accepted in parallel: 3–5×
on code edits, one reported 70s→20s large-file edit.
([OpenAI docs](https://platform.openai.com/docs/guides/predicted-outputs),
[Morph's guide](https://www.morphllm.com/openai/predicted-outputs)) Anthropic
has no public equivalent (Cursor cites this as why they self-hosted their
apply model).

**Prompt caching economics** (Anthropic): cache reads cost 0.1× input, writes
1.25× (5-min TTL) or 2× (1-hour); breakeven after 1–2 hits; **up to 85%
latency reduction on long prompts**; min cacheable prefix 1,024 tokens.
Our generation prompt (system prompt + full component catalog + few-shot
modules) is exactly the long-stable-prefix shape caching rewards.
([Anthropic](https://www.anthropic.com/news/prompt-caching),
[platform docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))

**Small-model routing**: cascades ("cheap model first, escalate on failure")
report 45–85% cost cuts at ~95% retained quality; an upfront classifier adds
only 50–100ms. For us the classifier is nearly free — the conversation model
already decides which tool to call; the win is *binding the view.json tool to
a fast small model* rather than routing per-query.
([TianPan cascades](https://tianpan.co/blog/2025-11-03-llm-routing-model-cascades))

## 2. Constrained/structured generation for the view.json tier

**Constraining does not hurt latency — it usually helps.** Modern grammar
engines (XGrammar, llguidance) add **<40–50µs per token**, negligible against
10–50ms/token inference; schema→FSM compilation costs ~50–200ms once and is
cached thereafter, and can overlap prefill. Constrained output also eliminates
filler, stops exactly at JSON-complete, and kills the retry/repair loop —
JSONSchemaBench (arXiv 2501.10868, ~10k real schemas, 6 frameworks) is the
reference benchmark. Caveat worth respecting: over-tight schemas can degrade
*content* quality on complex reasoning (declaration-order effects), so
constrain structure, keep string fields free.
([JSONSchemaBench](https://arxiv.org/pdf/2501.10868),
[grammar-constrained generation overview](https://tianpan.co/blog/2026-04-16-grammar-constrained-generation-output-reliability))

**Streaming partial-JSON UI is the established pattern everywhere:**

- **Thesys C1** (the "Generative UI API"): OpenAI-compatible endpoint returns a
  streamed JSON UI spec; their React SDK **renders components as the spec
  streams**, handling partial output gracefully.
  ([Thesys architecture](https://www.thesys.dev/blogs/generative-ui-architecture))
  Notably our `@vendoai/components` already wraps their OpenUI vocabulary.
- **Vercel AI SDK**: `streamObject`/`useObject` deliver progressively-parsed
  partial objects; v0 renders while streaming and runs mid-stream autofixers
  ("LLM Suspense", <250ms passes).
  ([v0 agent blog](https://vercel.com/blog/how-we-made-v0-an-effective-coding-agent))
- **Ecosystem parsers**: incremental JSON parsers that yield the deepest
  currently-valid prefix (openai-partial-stream, jsonriver, etc.); practitioners
  report first-paint going **from ~30s to ~1s** by rendering partials.
  ([openai-partial-stream](https://github.com/st3w4r/openai-partial-stream),
  [Aha! engineering](https://www.aha.io/engineering/articles/streaming-ai-responses-incomplete-json))
- **MCP Apps** standardizes host→view streaming args as
  `ui/notifications/tool-input-partial` with best-effort JSON repair — the
  protocol we already speak has the streaming slot built in.

Design consequence: emit `view.json` in a **streaming-friendly key order**
(node type and static props before children; data bindings last per node) so
the top of the tree is paintable earliest, and use breadth-first or top-down
document order in the schema.

## 3. Code-tier speed (Tier 2: esbuild iframe path)

**Compilation is not our bottleneck — token generation is.** esbuild bundles
~0.19s cold on small React projects and rebuilds in tens of ms; our compile
input is a *single ~≤64KB component file* with all heavy deps externalized to
the import map, so transform time is single-digit ms. The three real levers:

1. **Start compiling before the stream ends.** Multi-file modules stream file
   by file; run esbuild `transform` per file as each closes (or incremental
   `context.rebuild()` for the graph). By the time the last token lands, the
   bundle is warm. Sandpack does exactly this shape — transpile in web
   workers, per-file, on-demand loaders.
   ([Sandpack architecture](https://sandpack.codesandbox.io/docs/architecture/overview),
   [Building Sandpack](https://danilowoz.com/blog/sandpack))
2. **Prebundled dependency CDN.** Sandpack's biggest win was a custom CDN of
   pre-transpiled npm packages; Bolt keeps popular packages "in pre-compressed
   layers, so npm install often finishes in <500ms or is skipped entirely."
   Our import-map vendoring is the same idea; extend it from {react, lucide…}
   to a curated, versioned catalog of allowed deps, pre-vendored at host
   build time (`vendo sync`) so Tier-2 modules never fetch npm at all.
   ([Bolt/WebContainers](https://newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech))
3. **HMR-style patching instead of stage remount.** On edit, swap the blob URL
   in the import map and re-render, or integrate react-refresh so component
   state survives. Full iframe reloads re-run the MCP Apps `ui/initialize`
   handshake and lose scroll/form state; a module-level hot swap is
   ~milliseconds and keeps the surface alive. (No off-the-shelf numbers for
   this in-iframe pattern — UNVERIFIED win size, but the mechanism is standard
   Vite/react-refresh fare.)

**Compile-in-worker vs server**: keep compiling server-side (current
architecture) — it centralizes validation/sealing and avoids shipping
esbuild-wasm (which is materially slower than native; esbuild's own docs
recommend native). Browser-side compile only becomes interesting if we ever
want offline/local edit preview.

**WebContainers as a reference point, not a path**: full Node-in-browser boots
<2s and gives Bolt its instant full-stack preview, but it's proprietary
licensing, heavyweight, and our Tier 3 exists precisely so server code runs
server-side. ([WebContainers](https://blog.stackblitz.com/posts/introducing-webcontainers/))

**Skeleton-first progressive rendering**: stream the JSX top-down is not
possible for compiled code — but Tier 2 modules can ship a deterministic
skeleton (we already mint deterministic skeletons for remix baselines) that
renders instantly while the real bundle compiles/validates.

## 4. Edit-turnaround

State of the art triangulates on: **let the smart model be terse, let a fast
mechanism materialize.**

- **Cursor fast apply**: full-file rewrite beats diff formats for files <~400
  lines (diffs force fewer "thinking" tokens, are off-distribution, and models
  botch line numbers), so they made *rewriting* fast instead: fine-tuned
  Llama-3-70B + **speculative edits** — a deterministic draft (the original
  file) verified in parallel — ~1,000 tok/s, 13× vanilla 70B inference.
  ([Cursor blog](https://cursor.com/blog/instant-apply))
- **Morph fast-apply-as-a-service**: 7B specialized merge model; agent sends
  original file + abbreviated edit ("// … existing code …" markers); returns
  the merged file at **10,500+ tok/s, ~98% accuracy, $0.80/M input** — used by
  JetBrains, Vercel, Webflow. ([Morph](https://www.morphllm.com/blog/morph-gets-faster))
- **OpenAI Predicted Outputs**: same speculative-edit trick, hosted — supply
  the old file as the prediction, 3–5× faster edits, no extra model to run.
- **aider's evidence**: edit-format choice swings model behavior hugely
  (unified-diff format cut GPT-4-Turbo "lazy coding" 3×; search/replace blocks
  work better for some models) — the format is a *per-model* tuning knob, not
  a universal. ([aider](https://aider.chat/docs/unified-diffs.html))

**Our `edit_view` hunks already beat this game for Tier 1/2 single files**
(coordinate-mode hunks are cheaper than search/replace and we hold the
baseline server-side, so line numbers are safe — we sidestep Cursor's
objection because the server, not the model, resolves coordinates against a
pinned `baseHash`). The gap is **multi-file Tier 2/3 modules**: per-file hunks
still apply, but for large rewrites the winning shape is: smart model emits
abbreviated intent → Morph/Predicted-Outputs materializes per file → only
changed files rebuild. Regenerate-whole-repo should never be the default;
reserve it for structural rewrites (Cursor's <400-line finding suggests
full-file regen is fine for *small* files on a fast lane).

## 5. Server-tier cold starts (Tier 3)

Benchmarks (2026):

| Mechanism | Time | Source |
|---|---|---|
| V8 isolate start (Cloudflare) | **<5ms** | [CF](https://blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers/) |
| Firecracker snapshot restore (tuned) | single-digit ms – 28ms | [DIY 28ms](https://dev.to/adwitiya/how-i-built-sandboxes-that-boot-in-28ms-using-firecracker-snapshots-i0k); p50 3–4ms claims UNVERIFIED (secondary) |
| E2B fresh sandbox boot | 150–800ms | [benchmarks](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026), [gist](https://gist.github.com/homanp/b0bb68dad99a9434057e37e730a66039) |
| E2B resume-from-pause | **~1s** (pause costs ~4s/GiB RAM) | [E2B docs](https://e2b.dev/docs/sandbox/persistence) |
| Fly Machines suspend→resume | hundreds of ms | [Fly docs](https://fly.io/docs/reference/suspend-resume/) |
| Modal memory snapshots | ~10× cold-start cut (e.g. 20s→2s; 118s→12s w/ GPU) | [Modal](https://modal.com/blog/mem-snapshots) |
| Container cold start (Lambda-class) | 200ms–10s | [CF comparison](https://blog.cloudflare.com/cloud-computing-without-containers/) |

Implications:

1. **The build, not the boot, is the Tier-3 long pole.** A Nixpacks build is
   tens of seconds to minutes; sandbox boot is sub-second. Attack order:
   (a) **pool of pre-booted base sandboxes** with the runtime layers (python +
   uv, node + pnpm, common libs) already present — generation only writes
   files + installs the delta; (b) Nixpacks `cacheDirectories` + stable
   `--cache-key` per module lineage so rebuilds hit ~/.npm / pip caches;
   (c) **pause after first successful build** — reopening a module is then an
   E2B resume (~1s) with processes and memory intact, no rebuild. This is the
   warm-snapshot caching already in the design; the numbers confirm it's the
   right bet and say *pause aggressively, resume optimistically* (resume on
   module-card hover, not click).
2. **V8 isolates are a credible middle tier** for "light server code" in
   JS/TS: Cloudflare **Dynamic Workers** (open beta, April 2026) exists for
   exactly this — runtime-instantiated workers running AI-generated code,
   isolate starts in ms at ~100× less memory than containers, Cap'n-Web RPC
   host bridges, egress credential injection so generated code never sees
   secrets, and `@cloudflare/worker-bundler` for runtime npm bundling.
   ([CF blog](https://blog.cloudflare.com/dynamic-workers/),
   [InfoQ](https://www.infoq.com/news/2026/04/cloudflare-dynamic-workers-beta/))
   Self-hosted equivalents: workerd, Deno isolates. Tradeoff: JS/WASM only
   (no Python/bash tier-3 workloads), weaker isolation than a kernel boundary
   — fine for computation + fetch-through-broker, not for arbitrary binaries.

## 6. Reuse & module memory

- **v0's composite model is the proof of concept**: RAG over specialized
  knowledge feeds the base model; small "Quick Edit" model handles small
  changes; autofixer handles the tail. Retrieval is load-bearing in the
  fastest production UI generator. ([Vercel](https://vercel.com/blog/v0-composite-model-family))
- **Our own precedent generalizes**: prepared baselines turned first-remix
  from 32s into a 4.4s *edit*. A library of previously-generated, accepted
  modules (we already persist envelopes + sealed sources) is a corpus of
  prepared baselines: embed module descriptions, retrieve nearest accepted
  module for a new request, present it as the anchor base, and let `edit_view`
  hunks specialize it. "We've built 30 dashboards like this" becomes literal.
- **Parameterized templates** are the deterministic end of the same spectrum:
  for high-frequency shapes (table+filter, chart+summary, form+submit), ship
  first-party templates where generation only fills a params object —
  Tier-1-speed even for Tier-2 modules. Cache key: (host, component catalog
  version, request embedding) → template + params → derivation cache so the
  *same* request twice is a pure cache hit.
- **Few-shot with accepted modules** in the (prompt-cached) system prompt
  doubles as quality *and* speed: fewer retries, more predictable output for
  speculative/predicted decoding (drafts match more often when style is pinned).

## 7. Perceived speed — product patterns

What v0/Lovable/Bolt/Claude artifacts do while real work happens:

- **Always be streaming something**: v0 streams code visibly while a status
  line narrates; Claude artifacts render partial markdown/code live. Dead air
  is the enemy; token flow *is* the progress bar.
- **Skeleton loaders as first-class generated output** (Lovable ships them in
  generated apps; we should ship them in the *generation experience*): the
  module card appears instantly with title + inferred shape, fills in as the
  stream lands.
- **Optimistic scaffold**: Bolt shows file tree + terminal activity
  immediately; the preview pane exists before the app runs. Equivalent for us:
  the stage mounts with themed skeleton at tool-call start, not at
  tool-result.
- **Progressive capability (our structural advantage)**: none of these tools
  have our tier ladder. A request classified Tier 2/3 can still get an
  *instant Tier-1 approximation* — small model emits `view.json` of host
  components in ~1s, renders immediately, marked "upgrading…"; the code tier
  builds in the background and hot-swaps in. Worst case the user keeps a
  useful Tier-1 module; best case the upgrade lands in seconds. This converts
  Tier-3 minutes into Tier-1 seconds *perceptually* on every generation.
- **Background self-upgrade** also inverts failure UX: build errors in Tier
  2/3 never strand the user staring at a spinner — the Tier-1 surface stays.

## 8. Mapped onto Vendo

### view.json fast path (Tier 1)
- Constrained decoding against the view.json schema (structure constrained,
  strings free); schema ordered for top-down paintability. [S]
- Incremental-JSON parse in the runtime; stream partial trees to the surface
  over the existing UIMessage data parts (and to iframes later via MCP Apps
  `tool-input-partial`). Skeleton per node type until props complete. [S]
- Bind the view.json tool to a fast small model (Haiku-class or an open model
  on Cerebras/Groq/Fireworks via our BYO-provider seam); target <1.5s full
  tree. Escalate to the big model only on validation failure (cascade). [M]
- Prompt-cache breakpoint after {system prompt + component catalog +
  few-shot accepted modules}. [S]

### esbuild iframe path (Tier 2)
- Keep server-side esbuild; add per-file transform-as-the-stream-closes and
  incremental contexts for multi-file modules. [S–M]
- Extend import-map vendoring into a versioned pre-vendored dep catalog built
  at `vendo sync` time (Sandpack-CDN pattern, but host-local). [M]
- Hot-swap edited modules via new blob URL + re-render (later react-refresh)
  instead of stage remount; keeps MCP Apps session + UI state. [M]
- Deterministic skeleton (existing remix machinery) renders while the bundle
  compiles/validates; Tier-1 approximation renders while Tier 2 generates. [M]
- v0-style mid-stream autofixers: run our existing render_view validation
  gates *during* the stream and inject deterministic rescues (we already have
  deterministic rescues in the CLI extractor lineage). [M]

### server sandbox path (Tier 3)
- Pre-booted base-sandbox pool per runtime flavor; generation writes files
  into a warm sandbox, never boots cold. [M]
- Nixpacks `cacheDirectories` + per-module `--cache-key`; only changed layers
  rebuild on edit. [S]
- Pause after successful build (4s/GiB is fine post-hoc); resume (~1s) on
  module open, speculatively on hover. [M]
- Evaluate an isolate middle tier for JS-only server modules (Dynamic Workers
  hosted, or workerd/Deno self-hosted to stay BYO-infra): ms-start "light
  server" tier; keep microVMs for Python/bash/binaries. [L]
- Tier-1/Tier-2 surface renders immediately while the Tier-3 build runs;
  module upgrades itself when the sandbox is live. [M]

### edit loop (all tiers)
- `edit_view`-style hunks extended per-file across module repos (baseline
  normalization + baseHash per file); server materializes and rebuilds only
  touched files. [M]
- For big rewrites: abbreviated-edit → fast-apply materialization (Morph API,
  or Predicted Outputs when on OpenAI; both slot behind one "materializer"
  seam). Full-file regen on the fast lane for small files. [M]
- Edits to Tier 2 → hot-swap (above); edits to Tier 3 → layer-cached rebuild
  in the still-warm sandbox, never a fresh boot. [S, falls out of the above]

### Suggested sequencing
1 (stream-render) + 2 (prompt cache) are small and compounding — do first.
Then 5 (progressive capability) as the product-defining move, with 6 and 3
underneath it. 4 + 7 next as the edit loop hardens. 8 lands with Tier-3 GA;
9 and 10 are the second wave.

## Sources

- Cerebras: cerebras.ai/blog/cerebras-kimi-k2-Enterprise · cerebras.ai/press-release/llama4PR · generalinput.com/blog/cerebras-kimi-k2-6-inference-speed-generative-ui
- Groq: groq.com/lpu-architecture · groq.com/newsroom/groq-lpu-inference-engine-leads-in-first-independent-llm-benchmark
- Fireworks × Vercel (40×, autofixer, adaptive speculation): fireworks.ai/blog/vercel
- v0 architecture: vercel.com/blog/v0-composite-model-family · vercel.com/blog/how-we-made-v0-an-effective-coding-agent
- Predicted Outputs: platform.openai.com/docs/guides/predicted-outputs · morphllm.com/openai/predicted-outputs
- Prompt caching: anthropic.com/news/prompt-caching · platform.claude.com/docs/en/build-with-claude/prompt-caching
- Constrained decoding: arxiv.org/pdf/2501.10868 (JSONSchemaBench) · tianpan.co/blog/2026-04-16-grammar-constrained-generation-output-reliability
- Streaming partial JSON UI: thesys.dev/blogs/generative-ui-architecture · github.com/st3w4r/openai-partial-stream · aha.io/engineering/articles/streaming-ai-responses-incomplete-json
- Sandpack: sandpack.codesandbox.io/docs/architecture/overview · danilowoz.com/blog/sandpack
- WebContainers/Bolt: blog.stackblitz.com/posts/introducing-webcontainers · newsletter.posthog.com/p/from-0-to-40m-arr-inside-the-tech
- Cursor fast apply / speculative edits: cursor.com/blog/instant-apply · fireworks.ai/blog/cursor
- Morph: morphllm.com/blog/morph-gets-faster · morphllm.com/fast-apply-model
- aider edit formats: aider.chat/docs/unified-diffs.html · aider.chat/docs/more/edit-formats.html
- Cloudflare isolates / Dynamic Workers: blog.cloudflare.com/eliminating-cold-starts-with-cloudflare-workers · blog.cloudflare.com/dynamic-workers · infoq.com/news/2026/04/cloudflare-dynamic-workers-beta
- E2B: e2b.dev/docs/sandbox/persistence · superagent.sh/blog/ai-code-sandbox-benchmark-2026 · gist.github.com/homanp/b0bb68dad99a9434057e37e730a66039
- Firecracker/Fly: fly.io/docs/reference/suspend-resume · github.com/firecracker-microvm/firecracker (snapshot-support.md) · dev.to/adwitiya (28ms sandboxes)
- Modal snapshots: modal.com/blog/mem-snapshots · modal.com/blog/gpu-mem-snapshots
- Nixpacks caching: nixpacks.com/docs/configuration/caching
- Model routing/cascades: tianpan.co/blog/2025-11-03-llm-routing-model-cascades
