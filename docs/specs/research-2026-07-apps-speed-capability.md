# Modules Speed + Capability Roadmap (July 2026)

Synthesis of the 8-dimension apps-speed research sweep (2026-07-10): monogram
teardown, product teardowns (v0/Bolt/Lovable/Artifacts/Canvas), gen-UI SDK
survey, inference SOTA, sandbox/runtime latency, edit-loop SOTA, in-repo
latency audit at HEAD `3c32f2ba`, and capability levers. Companions:
`research-2026-07-module-speed.md` (solo survey, same day) and
`research-2026-07-framework-landscape.md` (protocol/SDK facts). Every claim
below traces to those reports; UNVERIFIED markers are inherited from them.

Goal restated: generation + render + edit-turnaround that feels like
monogram.ai (founder-claimed ~1.5s average to a full interactive UI, on a
"parallel processing architecture") while keeping the full module capability
ladder (view.json / sandboxed index.tsx / micro-apps) that monogram entirely
lacks. Monogram's speed comes from what maps to our tier 1 only: server-driven
native UI over a curated component catalog, no sandbox, no codegen in the hot
path (monogram report §3c, INFERRED from Ashby job stack: SwiftUI/UIKit +
WebSockets/gRPC, zero web tech). Their moat is speed; ours is capability +
embeddability. The plan below buys their speed without giving up our ladder.

---

## 1. TL;DR — top 12, ranked by expected impact / cost

| # | Recommendation | Tier | Expected win | Cost | Owner track |
|---|---|---|---|---|---|
| 1 | **Fix the `prepared` zod strip** in `vendo-server/src/vendo-dir.ts:36-42` (`prepared: z.string().optional()`), and put benchmark assertions on the 4.4s path so speed wins can't rot silently (methodology in §1.1 — deterministic stages in PR CI, live wall-clock in nightly only) | edit-loop | restores the shipped, measured 32s→4.4s first-remix path, currently OFF for every OSS install (confirmed live bug, flagged 2026-07-05, still unfixed) | S | server |
| 2 | **Instrument the seven seams** (model TTFT/step, per-step prefill **with per-segment prefix token counts**, judge latency, tool round-trip per call, stream-to-first-`data-ui`, iframe boot→first-paint, failure/retry rates) with `VENDO_BENCH`-style span logs | all | unblocks every other item; today the repo has exactly ONE timing line and every per-stage number is inferred. No TTFT percentage may be claimed for rec #3 until real prefix token counts are measured here | S | runtime |
| 3 | **Prompt caching on the stable prefix** (system prompt + catalog + tool schemas + captured source). Guaranteed win = **cost** (Anthropic cached reads at 0.1x input); TTFT upside is real but **depends on measured prefix size** (see §2 target table — the cited curve gives only ~4% at 20k tokens). Prerequisite: the §1.2 prefix measurement; provider caching matrix in §1.2 | all | zero caching exists at HEAD; up to 8 steps/turn re-prefill the full prefix. Cost win is unconditional; latency win to be sized by rec #2 data | S | runtime |
| 4 | **Stream-render view.json progressively**: streaming-friendly key order (identity/anchor/skeleton first, heavy children last), O(n) incremental parser (jsonriver-class, NOT AI SDK's default `parsePartialJson` — see §10 caveat), skeleton mounts the instant the component name resolves. Guard-layer interaction contract in §1.3 | view.json + perceived | first paint moves from full-emission time to ≈ TTFT + first-node parse (the defensible claim). The oft-quoted ~30s→~1s is from the companion solo survey (`research-2026-07-module-speed.md:121`), a single anecdotal source at chatbot payload scale, not module scale — treat as directional only | M | shell/stage |
| 5 | **Stop making the model retype data**: replace `render_view`'s "place each tool result VERBATIM in `data`" contract with server-side data splicing by reference/path (A2UI-style JSON-Pointer binds are the v2). Derived-data, validation, and staleness contract in §1.4 | view.json, edit-loop | output tokens are the dominant clock (repo-audit #1); data re-typing is pure waste and also enables live `dataModelUpdate` refresh without regeneration | M | runtime |
| 6 | **Fast-lane the view.json tier**: bind it to a fast small model + strict structured outputs *where the provider supports them*, else validate-and-repair; escalate to frontier on validation failure. Gated on rec #11's quality eval. Key-configuration behavior in §1.5 | view.json | the tier ladder IS the router (no learned classifier needed); RouteLLM-class 40–85% cost cuts; sub-second TTFT is achievable at this tier — but "monogram-feel" is **unproven until rec #11's corpus eval passes** on a Haiku/Flash-class model, and constrained decoding on hosted APIs is a correctness lever, not a throughput lever (§5) | M | runtime |
| 7 | **Persistent stage: hot-swap instead of fresh iframe per view/edit**; keep the 4.1MB component bundle out of the per-realm structured clone via jail-safe mechanisms only (transferable ArrayBuffer, or one persistent realm per page that evaluates the bundle once) — NOT by URL inside the sandbox (CSP analysis + swap security policy in §1.6); parallelize the 3 serial env RTTs; swap edited modules via new blob URL (later react-refresh) | iframe | removes the ~100–500ms+ (UNVERIFIED) per-view floor that becomes THE bottleneck once model time shrinks; edits keep UI state instead of re-running ready/init handshakes | M | stage |
| 8 | **Generalize `edit_view` → `edit_module`**: per-file normalized baselines with `baseHash` = git blob OID, coordinate-mode hunks, `addFile`/`deleteFile`/`renameFile` ops; conflict policy in §1.7 | edit-loop | applies the in-repo 32s→4.4s mechanism to every module tier; `hunks.ts`/`baseline.ts` are file-agnostic. **Cost is split**: hunk/baseline transplant + file ops = M; cross-file import/typecheck gates + tier-3 "patched→building→swapped" async-build progression = a separate L-class follow-up (generated view components are deliberately isolated blob modules today — real multi-file imports are new machinery) | M (+L follow-up) | runtime |
| 9 | **Move the guard + tool path off the serial hot path**: prompt-cache the judge prefix; fire the judge as each call's input completes so judging call N overlaps the model still streaming call N+1 in the same step; judge and execute independent calls in a step in parallel. Keep ONLY the existing per-`toolCallId` needsApproval/execute-pair dedupe — **no cross-call memoization** (§1.8: that pattern was removed as a security fix; memo scope is ENG-193's decision, not a speed knob) | all (act-tier tools) | today one un-streamed `generateText` per act-tier tool call, serial before execute (~0.3–1.5s/call UNVERIFIED, ~1–4s on a 3-call turn), and tool execution is serialized behind it | S–M | runtime |
| 10 | **Progressive capability ladder**: every tier-2/3 request first paints a tier-1 approximation (budget: p50 ≤1.5s to paint, same lane as rec #6), produced by **the same stream emitting a view.json block first** — no second model call; the approximation is **read-only** ("upgrading…" affordance, interactivity frozen, no state carry-over in v1) and the real build swaps in when ready; tier-3 builds run async at publish/save (Nixpacks ~90s can never be mid-conversation) with warm snapshot per module version; E2B pause/resume is same order as its ~150ms create per third-party benchmarks (exact resume latency unmeasured — verify before committing a re-open budget); speculative resume on hover | server + perceived | perceived TTFR = tier-1 speed on every generation regardless of final tier; no product in the teardown set has this ladder, it is our structural advantage | M–L | runtime + cloud |
| 11 | **Tier-1 quality eval gate**: pairwise screenshot-MLLM-judge + deterministic gates over the existing nightly corpus jobs (the monogram variation-scoring loop, §3/§9), run BEFORE rec #6's model swap and as its permanent regression gate | view.json | downgrading the model without a quality harness is the silent-regression failure mode this doc warns about for speed; this is the explicit gate. Also the prerequisite for ever fine-tuning (§10) | M | runtime |
| 12 | **In-stream repair ladder for tail latency**: promote the render_view JSON-repair middleware from app-level to runtime; add deterministic mid-stream fixes (schema-name repair, bracket balance) so validation failures don't 400 the turn or force a full re-generation; measure failure rates via rec #2 (§2.3) | all | today a render_view JSON break 400s the whole turn (repo memory: tool-input JSON repair), a hunk mismatch costs a full extra turn (4.4s → ~9s+), and rec #6's escalation pays fast-model time PLUS frontier time on failure. p95 is unknowable until these rates are measured; repair-in-stream is the v0 AutoFix idea (§4) applied to our stack | M | runtime |

Sequencing: 1+2+3 are days-class and compounding; do them first (2 before
claiming wins from 3). Then 11 (the eval gate), then 4+5+6 as one "instant
tier 1" campaign — **6's model swap does not land until 11 is green** — with 7
in parallel (client-only). 8+9+12 harden the loop. 10 is the product-defining
move and lands with tier-3 GA. Retrieval-into-remix (accepted modules as
prepared baselines, §8 below) rides on 8 as a second wave; the tier-3 half of
8 (cross-file gates, async-build progression) is its own L-class follow-up and
must not be silently absorbed into the days-class narrative.

Smaller follow-ups (real, but below the top-12 line):

- **First-turn tool ingestion** (§2 today-table): persist tool manifests keyed
  by server-config hash, refresh in background, circuit-break dead MCP servers
  instead of re-paying the connect timeout every 30s. Cost S.
- **Context growth**: prompt caching does not fix the growing suffix — turn 20
  is structurally slower than turn 2. History compaction policy, tool-output
  eviction (`capToolOutput` already exists for voice), and a per-turn prefix
  growth budget. Cost S–M; deferred until rec #2 shows the actual growth rate.
- **Delivery**: immutable-cache + brotli for the vendor bundle with an
  explicit size budget (the stage pays 4.3–7MB of first-load fetches today);
  and verify the host's deployment does not buffer the SSE stream — proxy
  buffering on Vercel/nginx is a classic silent TTFT killer that no model-side
  fix recovers. Cost S.

### 1.1 Rec #1 benchmark methodology (what "CI assertion" means)

The 4.4s path includes a live LLM call — nondeterministic, provider-variant,
and costly, so it cannot be asserted in PR CI:

- **PR CI** asserts only the deterministic server stages: baseline prepare,
  hunk apply, validate + sucrase compile, on recorded fixtures, in ms with
  generous thresholds (these are single-digit-ms today; the assertion exists
  to catch algorithmic regressions, not noise).
- **Model time** is proxied by **emitted-token count per op** on recorded
  fixture conversations — a deterministic number that catches "the prompt
  started making the model retype the file" without any live call.
- **Live wall-clock** (the actual 4.4s-class number) runs in the existing
  nightly corpus jobs (skateshop/umami fixtures), p50 over 5 runs, alerting
  threshold p50 ≤ 8s. Never in PR CI.

### 1.2 Rec #3 prerequisites: measure the prefix, and the provider matrix

Before implementation, measure a real demo-bank conversation and report
tokens per prefix segment — system prompt, component catalog, captured source
(≤48KB ≈ ~12k tokens per repo-audit §1.3), DOM snapshot, tool schemas,
history — and state the stable-per-host vs per-conversation vs per-turn
fraction. The plausible total sits in the 15–50k range, where the cited TTFT
curve predicts single-digit-to-modest cuts (§2), so the win size is unknown
until measured. The cost win (0.1x cached reads) holds at any size.

Caching is provider-specific and the repo is provider-agnostic
(`@vendoai/server`, BYO-any-provider, PR #42):

| Provider | Mechanism | Notes |
|---|---|---|
| Anthropic | explicit `cacheControl` breakpoints | writes 1.25x/2x; 5m/1h TTL |
| OpenAI | automatic prefix caching | −90% cached input, 24h retention (2026-05-29); byte-level prefix drift invalidates |
| Gemini | explicit caching, paid + TTL-based | different model entirely: storage billed per MTok-hour; implicit caching exists but is best-effort |

The abstraction lives in the provider seam in `@vendoai/server`: the engine
declares breakpoint *intents* (static / per-host / conversation) and each
provider adapter maps them to its native mechanism or no-ops. Do not leak
`cacheControl` into engine code.

### 1.3 Rec #4: progressive render vs the guard layer

Progressive render must not leak un-approved act-tier data — the approval flow
is Vendo's core differentiator and outranks paint latency:

- **Pure-read data may paint pre-approval.** Reads are never judged
  (judge-policy tier "read" flows untouched), so read-tool results streaming
  into partial props are safe to render immediately.
- **Act-tier-bound content may NOT paint before its producing call is
  allowed.** The skeleton may mount on component-name resolution, but any prop
  fed by an act-tier tool renders a placeholder until the judge allows the
  call and any mid-turn `ApprovalCard` resolves.
- **Denial does not roll back paint.** On a mid-stream denial the placeholder
  resolves to an explicit denied state ("not authorized") in place; read-fed
  components already painted stay. No component silently disappears.

### 1.4 Rec #5: derived data, validation, staleness

Pure by-reference splicing removes the model's ability to reshape values —
and the model reshapes constantly (reformatting, filtering, aggregating, unit
conversion; the donut-cents bug is the standing proof that formatting at the
bind seam is a live hazard). The contract:

- **v1**: verbatim pass-through goes by reference; the model **may still
  inline small derived values** (aggregates, formatted strings). Splicing is
  mandatory only for arrays/objects above a size threshold, where the token
  win lives.
- **v2**: declarative server-evaluated transforms — A2UI-style formatters plus
  a JSONata-class expression option (JSONata is already the automations DSL
  precedent). Unit conversion is always an explicit formatter, never implicit.
- **Bind-time shape validation**: every reference is validated against the
  recorded tool-result shape at splice time; on mismatch, fall back to asking
  the model to inline (one-turn repair, same shape as hunk-mismatch retry).
- **Missing/stale reference**: render the component's placeholder and trigger
  a refresh; never render silently stale data.

### 1.5 Rec #6: fast-lane behavior per key configuration

The locked OSS install model is zero-infra BYO-keys, "one key = core magic".
The fast lane must be a **model choice within the host's existing key**, not a
second-vendor requirement:

- **Single Anthropic key (the default OSS install)**: fast lane = Haiku 4.5
  via the same key. Still a real win: ~0.70s TTFT / ~114 tok/s and $1/$5 per
  MTok vs Sonnet-class defaults — a 2k-token view.json emits in ~18s vs ~40s+
  at typical Sonnet OTPS (exact ratio to be measured by rec #2).
- **Single OpenAI key**: gpt-5-mini-class; **single Gemini key**: Gemini 3
  Flash (~193 tok/s). Mind the Gemini structured-output gotchas already in
  repo memory (numeric enums).
- **Multi-key / speed enthusiasts**: opt-in `models.viewTier` override in
  `vendo.config` can point at Cerebras/Groq/Fireworks (gpt-oss-120b on
  Cerebras: ~3,000 tok/s **vendor-self-reported** — the corroboration is a
  press-release echo site — and Cerebras access is enterprise/waitlist-gated
  per inference.md, so this lane may simply not be available to a typical OSS
  host). The host pays for whatever key they configure.
- **Capability gate + fallback**: the fast lane engages only when the
  configured provider supports strict structured outputs for the catalog
  schema; otherwise the tier runs on the default model with validate-and-
  repair (the existing `jsonRepairMiddleware` path). Unavailable fast model =
  silent fallback to the default model, never an error.

Caveats carried from the source reports: genui-sdks §6 cites a 2026 study
showing constrained decoding on SMALL models can cost 3.6–8.2x latency and
quality loss in the worst configurations; the "~50% faster" number is from
self-hosted Guidance engines and hosted APIs are only neutral-to-positive
(§5). So: an early corpus eval of Haiku/Flash-class models on real view.json
prompts (rec #11) is a **prerequisite** before declaring this tier
monogram-capable, and Cerebras/Groq constrained-decoding support is unverified.

### 1.6 Rec #7: sandbox-safe mechanism and swap security policy

The original "serve the bundle by cached URL" phrasing is **not jail-safe**:
the stage iframe CSP is `connect-src 'none'` with `script-src` limited to a
per-call nonce + `blob:` (`stage-host.ts:10,14,62`), precisely so generated
code has no GET-request exfiltration channel. Loading the bundle by URL means
adding an origin to `script-src` inside the sandbox realm — reopening the
channel the F3a egress jail was locked to close. The per-realm cost is real
(4,120,791-byte bundle structured-cloned + re-evaluated per iframe, verified
at `apps/gmail/build/vendo/components-sandbox.js`); the fix must keep the CSP
shut. Jail-safe options, in preference order:

1. **Transfer the bundle as a transferable ArrayBuffer** over postMessage —
   zero-copy, no clone, no CSP change; re-eval cost remains but the multi-MB
   clone disappears.
2. **One persistent stage realm per page** that evaluates the bundle once and
   hosts hot-swapped views — the clone AND the re-eval are paid once.
3. **Same-origin nonce'd `<script src>` pinned by hash** — only with an
   explicit sandbox threat-model review; any `script-src` loosening requires
   F3a-owner sign-off, full stop.

Realm-reuse security policy (the F3a gates were validated for
fresh-iframe-per-view; reuse changes the model and needs its own analysis):

- **Swap scope v1: same module lineage only** (versions/edits of one module).
  Two *different* modules never share a realm — state/secret bleed between
  modules is otherwise unauditable.
- **Teardown on swap**: unmount the React root, revoke prior blob URLs, clear
  timers/intervals/listeners registered through the bridge, and evaluate the
  incoming module in a fresh module scope. Globals the old module smuggled
  onto `window` are the reason cross-lineage swaps are banned in v1.
- **Re-validate under reuse**: the egress-jail CSP, host-component-as-data,
  and the ready/init handshake assumptions (which currently assume a
  fresh realm) must be re-run against the persistent-realm design before it
  ships.

### 1.7 Rec #8: concurrent-edit semantics

Once the server-held base is repo HEAD and an applied op is a commit, two
surfaces can race: two conversations, voice + text sessions, a conversation
plus the zero-LLM direct-manipulation path (§4), or an automation touching a
module. Policy:

- **Per-module optimistic locking** via `baseHash` (git blob OID). A stale
  hash **rejects the op and echoes the current lines** — the same one-turn
  retry shape as a hunk mismatch, so the model (or the direct-manipulation
  client) rebases itself in one round trip.
- **Non-overlapping files auto-rebase**: if the racing commits touch disjoint
  files, apply on top transparently.
- **v2, only if racing surfaces become real in telemetry**: per-conversation
  branches with merge-on-save. Not built speculatively.

### 1.8 Rec #9: why there is no cross-call memo

An earlier draft proposed memoizing the judge "across identical calls in a
turn". Struck: the judge-policy docstring
(`judge-policy.ts:44-59`) documents that the prior memo key
(principal+thread+tool+input) was replaced with per-`toolCallId` memoization
as a security fix, because a cached verdict could silently replay after the
run's provenance had become tainted. Within-turn taint has the same shape — a
read between two identical act-tier calls can poison provenance, and a
cross-call memo would auto-approve the second call, violating the locked
"guard on every tool call" invariant. Judge memoization scope is a security
decision owned by ENG-193; speed recovers via the other two levers
(prompt-cached judge prefix; judging call N while the model streams call N+1 —
note the ai SDK invokes `needsApproval` at input-complete, which is already
the earliest moment the final input exists, so the only real concurrency is
across multiple calls in one step, not within one call's input stream).

---

## 2. The latency budget — where time goes today vs where it could go

From the repo audit (HEAD `3c32f2ba`; the only measured numbers in the repo
are first remix 32s→4.4s, pin edits ~6s, and the single `VENDO_BENCH` line in
`edit-view-tool.ts:281`):

### Today: a typical "show me X" render turn

| Stage | Cost today | Why |
|---|---|---|
| First-turn tool ingestion (Composio + MCP `tools/list`) | multi-second (unmeasured range), first turn per user/process only | documented in-source (`engine.ts:629`); promise-cached after; a down MCP server re-adds its connect timeout every 30s (fix in §1 follow-ups) |
| Per-step prefill, ×2–8 steps/turn | seconds of TTFT per step | zero prompt caching anywhere in packages/; prefix = system + up to 48KB source + DOM snapshot + history + all tool schemas |
| Judge LLM call per act-tier tool call | ~0.3–1.5s/call UNVERIFIED, serial | `judge-policy.ts:249-279`, memoized only within one call's approve/execute pair |
| Tool execution (host API + Composio/MCP round-trips) | **unmeasured — no timing exists**; serialized behind the judge, and independent calls in a step run sequentially today | in every act-tier turn's critical path; rec #2 seam |
| Model emission of the full `render_view` payload | **tens of seconds; 90%+ of TTFR** | nothing paints until the last token: tree + tool data re-typed verbatim + up to 16×64KB component source; only a skeleton chip during input-streaming |
| Server validate + sucrase compile + hunk apply | single-digit ms | NOT a bottleneck; the bench hook exists to prove it |
| Fresh iframe per view AND per edit | ~100–500ms+ UNVERIFIED | multi-MB srcdoc parse, 4.1MB bundle structured-cloned + re-evaluated per realm, ready/init handshakes; first stage on a page also pays ~4.3–7MB of fetches with 3 serial env RTTs |

### Target: where each millisecond could go

| Stage | Attainable | Mechanism (report) |
|---|---|---|
| Prefill/TTFT per step | TTFT cut ~4% at 20k tokens rising to ~52% at 160k (UNVERIFIED single-Medium-source curve); OpenAI measured 67% at 150k+. Our 15–50k-range prefix (§1.2) predicts single-digit-to-modest TTFT cuts until measured. Cost cut (0.1x cached reads) is unconditional; marginal turn cost ≈ output tokens only at large prefixes | prompt caching (inference §5) |
| view.json first paint | ~1s | fast small model + partial-tree streaming; structured outputs for skeleton-safety (inference §6, genui-sdks §7–8) |
| view.json full tree (2k tokens) | ~18s at Haiku ~114 tok/s; <1s at ~3,000 tok/s (Cerebras, vendor-self-reported, waitlist-gated) | provider fast lane (inference §2) |
| Edit turn, any tier | 4.4s-class | hunks; already proven in-repo, currently regressed for OSS (editloop §1) |
| Tool execution per act-tier call | judge overlapped with streaming (§1.8) + independent calls executed in parallel (AI SDK supports parallel calls; the guard serializes today). Speculative read-tool prefetch for predictable intents = candidate lever, unevaluated — keep on the list even if rejected | rec #9 |
| Tier-2 bundle | ≤50ms edit / ≤150ms cold | server-side native esbuild, persistent rebuild contexts, shared vendor bundle (runtime §Tier 2); esbuild-wasm is ~10x slower, never in-browser |
| Iframe render | tens of ms warm (UNVERIFIED estimate; instrument via rec #2) | persistent stage + hot swap (repo-audit §2, runtime §Tier 2) |
| Tier-3 re-open | 5–150ms snapshot restore; E2B pause/resume same order as its ~150ms create per third-party benchmarks (exact resume latency unmeasured — verify before committing a re-open budget; the ~1.5s resume figure belongs to CodeSandbox) | warm snapshot per version; boot ladder: isolate ~5ms → snapshot restore 3–30ms → microVM boot <125ms → container 1–3s → Nixpacks build ~90s (runtime table) |
| Tier-3 first generation | ≤1.5s to the tier-1 placeholder (rec #10), ≤120s wall to the live module behind progress UI — async, never blocking the conversation | build async at publish; reasoning TTFT (GPT-5.5 high ~29.8s) + build dominate (inference §8) |

### 2.1 Composite per-tier SLOs — what "done" means

Per-stage numbers don't define success; these composites do. All budgets are
**user-send → first paint / → interactive**, measured on the demo-bank
fixture conversation on the nightly corpus runner (same environment as the
Layer-3 live jobs), default single Anthropic key. p50 and p95 over ≥5 runs.
Every number elsewhere in this doc is best-case unless marked otherwise; these
are the binding ones.

| Tier / turn type | p50 first paint | p50 interactive | p95 first paint | p95 interactive |
|---|---|---|---|---|
| Tier 1, first render | ≤1.5s | ≤3.5s (full tree) | ≤4s | ≤8s |
| Tier 1, edit | ≤1.5s (patch applied) | ≤1.5s | ≤5s (includes one hunk retry) | ≤5s |
| Tier 2, first render | ≤1.5s (tier-1 approximation) | ≤10s (live module) | ≤4s | ≤20s |
| Tier 2, edit | ≤5s | ≤5s | ≤10s | ≤10s |
| Tier 3, first generation | ≤1.5s (placeholder) | ≤120s wall, progress UI | ≤4s | ≤180s |
| Tier 3, re-open | ≤1s | ≤1s | ≤3s | ≤3s |

Sub-budget composition for the headline cell (tier-1 first render, p50 ≤1.5s
to first paint): prefill/TTFT ≤0.8s + first-node emission ≤0.3s + parse/mount
≤0.2s + slack 0.2s. Rec #2's instrumentation is judged against this table;
"monogram-feel" and "instant tier 1" mean these numbers and nothing else.

### 2.2 Cost to the host — rough per-turn/per-module dollars

BYO-keys means the HOST pays every recommendation's inference and infra cost;
"cost" in the §1 table is engineering cost only. Rough modeling (assumption:
host-borne inference cost is acceptable up to ~$0.10 p50 per chat-class turn;
anything projected above that gets flagged in its rec):

- **Prompt caching (rec #3)**: cache writes cost 1.25x/2x on first write;
  break-even after ~1–2 cached reads, then strictly cheaper. Gemini explicit
  caching adds storage billed per MTok-hour — size the TTL to conversation
  length or it costs more than it saves.
- **Judge (rec #9)**: one small-model call per act-tier tool ≈ $0.001–0.01;
  a 3-call turn adds ≈ $0.01–0.03.
- **Fast lane (rec #6)**: Haiku $1/$5 per MTok — a tier-1 turn lands ≈
  $0.01–0.03 vs $0.05–0.15 on Sonnet-class. The fast lane is a cost cut, not
  a cost add.
- **Tier-3 snapshots (rec #10)**: E2B warm-snapshot storage + resume pricing
  UNVERIFIED — obtain pricing before GA; per-module-version storage grows
  unbounded without an eviction policy.
- **Self-test loops (§9)**: Replit's median $0.20/session is the reference
  ceiling for a tier-3 verify pass.

### 2.3 Tail latency and failure rates — the missing half of the budget

Every number above is a success-path number. Known failure paths, none with a
measured rate (rec #2 must capture all three):

| Failure | Cost today | Mitigation |
|---|---|---|
| render_view JSON breakage | **400s the whole turn** (repo memory: tool-input JSON repair; app-level middleware exists, not in runtime) | rec #12 promotes repair into the runtime, in-stream |
| Hunk mismatch | one full extra turn: 4.4s becomes ~9s+ (mismatches echo actual lines for a one-turn retry) | rec #1's nightly bench tracks retry rate; §1.7 keeps conflict retries to one round trip |
| Fast-lane validation failure (rec #6) | user pays fast-model time PLUS full frontier time | escalation rate is the eval-gate metric (rec #11); if >~10% the fast lane is a net loss and stays off |

Until these rates are measured, no p95 in §2.1 can be claimed as met — the
p95 columns exist precisely to force the failure paths into the measurement.

The unifying rule from the runtime report: move every non-generation cost off
the conversational path via content-addressed caches (bundle hash,
snapshot-per-module-version) so the LLM token stream is the only thing the
user ever waits on. And the unifying rule from the edit-loop report: the
32s→4.4s win came from moving work, not speeding inference; the model types
only what changed.

---

## 3. Monogram — the benchmark and the collision course

Source: `apps-speed/monogram.md` (launch blog, Ashby job board, PitchBook/Yahoo
interview, HN 48835018, Product Hunt; app is 10 days old, iOS-26-only).

- Out of stealth 2026-07-07, $40M seed (DST + Lux); founders Eren Bali
  (Udemy/Carbon Health), ex-Airbnb VP Product AI, ex-Carbon Health VP Eng.
- Claim: **~1.5s average to a full interactive UI** via a "parallel processing
  architecture", on OpenAI models plus experimental open-source versions;
  admits it costs more compute than chat. Founder claim, no third-party
  measurement exists yet.
- Stack (VERIFIED from job postings): server-driven NATIVE UI. Swift/SwiftUI/
  UIKit + WebSockets + gRPC; designers craft "building blocks"; a dedicated
  "core UI generation model" plus an eval platform doing "automated UI
  variation scoring". No web tech, no codegen, no sandbox anywhere: this is a
  tier-1 view.json analog with zero sandbox tax, and nothing resembling our
  tier 2/3 appears in the hot path.
- Follow-ups use a two-path design (Bali on PH): "edit UI components" or
  "regenerate a whole new interface", independently converging on edit_view.
- Founder on HN: 9 months, 3-person team as of Nov 2025, "most of the work...
  was to build the infrastructure... especially to make it fast". Speed came
  from infra, not a bigger model.
- They plan to open the architecture to developers, a future direct collision
  with our embedded-agent market. Today: no module concept, no permission
  layer, no persistence/git model.
- Most copyable idea: the **UI-variation eval loop**. Automated scoring over
  generated variants is their training/selection lever; a measurable quality
  loop over view.json variants would let us push a smaller/faster model at
  tier 1 without quality regression (now rec #11, on the existing
  corpus/nightly jobs).
- Honest gaps: wire protocol, constrained decoding, fine-tuning, prefetch,
  edit latency, layout determinism all UNVERIFIED. Beware unrelated
  monogram.io polluting search.

Read: their 1.5s is what our tier 1 can be. Nothing they've shown threatens
tiers 2/3; everything argues we should make tier 1 feel instant first.

### 3.1 GigaCatalyst — the actual closest competitor (coverage gap)

GigaCatalyst (YC P26) is recorded elsewhere as Vendo's closest direct
competitor — the other "agent your product ships with" play — and was NOT in
this sweep's teardown set; the omission is a coverage gap, not a judgment. No
public latency data, no published architecture, feature surface UNVERIFIED as
of 2026-07-10. Nothing observed in their public positioning contradicts the
tier-ladder plan, but this doc cannot claim the top-12 matches or beats them.
Action: add a GigaCatalyst teardown to the next competitive sweep; until then
monogram is the speed benchmark and GigaCatalyst is the positioning benchmark.

## 4. Product teardowns — what makes tools feel fast

Source: `apps-speed/products.md` (v0, Bolt.new, Lovable, Claude Artifacts,
ChatGPT Canvas).

- **In-stream error repair (v0)** is the strongest actual-speed idea: a custom
  small AutoFix model (`vercel-autofixer-01`; 8,130 chars/sec and 86%
  error-free standalone are **Vercel self-reported / Fireworks co-marketing,
  UNVERIFIED** per capability.md) corrects the frontier stream while it
  streams, eliminating visible retries. Generalizes directly from our
  render_view JSON-repair middleware (now rec #12).
- **Bolt's speed is structural**: WebContainers run Node in-browser (zero
  sandbox round-trip), a streaming boltAction parser writes files and starts
  the dev server before generation finishes, CDN-cached pre-compressed npm
  layers make install <500ms. The preview is live while the model still types.
  Our analog: boot/warm the runtime on first streamed file, not on completion
  (expected win UNQUANTIFIED — on the order of the sandbox create/boot time it
  hides, ~150ms–3s depending on rung; measure via rec #2 before building).
- **Everyone converged on a surgical edit protocol** because the second-turn
  edit is where tools feel fast or slow: Claude Artifacts `update`
  string-replace (Oct 2025, 3–4x), Canvas generated regexes, v0 QuickEdit.
  This validates edit_view hunks as the industry pattern.
- **Zero-LLM edit path** for styling/text nits: v0 Design Mode (live style
  panel, zero credits) and Lovable Visual Edits (in-browser AST via Babel/SWC,
  Vite-plugin JSX-element IDs, optimistic client-side Tailwind generation).
  Direct manipulation persisted back to source is the cheapest perceived-speed
  win available (latency UNQUANTIFIED in the reports; client-side, so
  plausibly sub-100ms perceived); for us it extends remix machinery to
  token-level theme edits, and inherits §1.7's conflict policy.
- **A rigid skeleton is a speed feature** (Lovable): one identical
  vite_react_shadcn_ts + Supabase stack for every app means no boilerplate
  tokens and no infra decisions; 60–90s to first working version. Argues for
  per-tier module templates/scaffolds.
- **First-meaningful-render reality (2025 head-to-heads)**: v0 ~30s for
  components; Bolt "seconds" to live preview / ~20min full app; Lovable
  ~60–90s first version / ~35min polished; Artifacts ≈ single-file stream time
  into a client-side sandboxed iframe (the same shape as our tier 2).
- **Perceived-speed hygiene shared by all five**: never a blank screen (code
  streams from t=0), legible progress (file/step checklists beat spinners),
  visible diffs beat full re-streams, context compression keeps later turns as
  fast as the first (our context-growth follow-up, §1).

## 5. Gen-UI SDKs and protocols — how to stream a UI tree

Source: `apps-speed/genui-sdks.md` (Thesys C1, Vercel AI SDK, assistant-ui,
CopilotKit, Google A2UI, constrained-decoding literature).

- **Constrained decoding: split the claim by where inference runs.** The
  latency WIN is local-inference-only: JSONSchemaBench (2025) measured
  Guidance at 6.4–9.5ms/token vs 15–16ms unconstrained (~50% faster) because
  the grammar engine fast-forwards forced tokens — a mechanism hosted APIs do
  not expose to callers. On hosted Anthropic/OpenAI structured outputs the
  effect is **neutral-to-positive at best** (historically hosted structured
  modes add overhead), so on the BYO-provider seam constrained decoding is a
  **correctness + skeleton-safety lever** (streamed prefixes can't hallucinate
  component names, making rec #4's speculative mounts rollback-safe), NOT a
  throughput lever. The ms/token speedup applies only if/when running open
  models on controlled infra (the Cerebras/Fireworks lane). Also: a 2026 study
  (genui-sdks §6) found constrained decoding on SMALL models can cost 3.6–8.2x
  latency with quality loss in bad configurations — carried into rec #6 as a
  gate. Quality fears for well-configured setups were rebutted (dottxt "Say
  What You Mean", 2024-11; 3–4pt task-quality GAINS in JSONSchemaBench). Real
  hosted cost: first-request schema compile (OpenAI <10s typical, up to 60s;
  then cached; Anthropic structured outputs GA with modest init overhead).
  Consequence: ONE stable per-host catalog schema, pre-warmed at publish time,
  never per-module dynamic schemas on the hot path.
- **The 2026 protocol consensus is flat, not nested**: Google A2UI
  (open-sourced Jan 2026, v0.9 Apr 2026) streams a FLAT ID-referenced
  component list as JSONL: progressive render without any partial-JSON parser,
  incremental component-level updates (protocol-level analog of edit_view
  hunks), and LLMs generate adjacency lists more reliably than nested trees.
  view.json is a nested tree, so flat encoding would be the single biggest
  protocol change available — **decision made in §10: deferred with an
  explicit revisit trigger**, because it breaks the view.json contract across
  renderer, prompt catalog, corpus fixtures, persisted modules, and remix
  baselines.
- **AI SDK's default partial-JSON path is O(n²)** over the stream; the O(n)
  fix (PR #1883, >100x) was rejected in 2024, and third-party benches still
  show ~6s parse time at 100KB payloads — though it is UNVERIFIED whether AI
  SDK 5/6 has since fixed this internally (a 10-minute bench of the current
  version settles it; do that before building rec #4's parser). At
  module-sized specs use an O(n) incremental parser (jsonriver, fn-stream,
  vectorjson) + render throttling.
- **Streaming React components lost; streaming data won**: AI SDK RSC/streamUI
  is officially experimental, "not recommended for production". Every
  surviving SDK (Thesys, assistant-ui, CopilotKit, A2UI) renders a declarative
  spec against a client-owned catalog. Direct validation of the view.json
  tier.
- **Skeleton-on-tool-name / speculative hydration** is the perceived-latency
  killer: mount a placeholder the instant the component/tool name resolves
  mid-stream, fill props as partial args arrive (assistant-ui ships this;
  vercel/ai#13469 calls it "zero-latency generative UI"). Structured outputs
  make it rollback-safe: streamed prefixes can't hallucinate invalid names.
- **Schema key ORDER is render choreography** (CopilotKit OpenGenerativeUI):
  LLMs emit keys in schema order, so put identity/anchor/size/skeleton fields
  first and heavy children last in the module envelope and view.json schema.
- **Thesys C1** (closest commercial analog) is tier-1-as-an-API: a compact
  JSX-like DSL rendered progressively via an `isStreaming` prop. Its levers
  are token-cheap encoding + partial-spec re-render, nothing exotic. Token
  count is the dominant wall-clock term; encoding compactness beats parser
  cleverness.

## 6. Inference — providers, caching, routing

Source: `apps-speed/inference.md`.

- **The tier ladder IS the router**: view.json → Haiku 4.5 (~114 tok/s, 0.70s
  TTFT, $1/$5) / Gemini 3 Flash (~193 tok/s, 0.66s TTFT) / gpt-oss-120b on
  Cerebras (~3,000 tok/s **vendor-self-reported** from Cerebras' own blog —
  the "corroboration" is a press-release echo site — with full 128k, and
  capacity is enterprise/waitlist-gated, so treat as an opt-in enthusiast lane,
  not the default); index.tsx → fast coding model (gpt-oss-120b / Qwen3-Coder
  on Cerebras/Groq/Fireworks, or Sonnet for quality); tier 3 → frontier +
  progress UI. Deterministic escalation on validation failure = a cascade
  router with a verifier, no learned classifier. RouteLLM-style 40–85% cost
  cuts come free from the structure.
- **Prompt caching is the cost lever, and the TTFT lever at large prefixes**:
  Anthropic reads 0.1x input (write 1.25x/2x), OpenAI −90% cached input with
  24h default retention since 2026-05-29 and measured 67% faster TTFT at 150k+
  tokens; the TTFT curve at our prefix sizes is modest (§2 target table).
  Structure the prefix as [static system + catalog] → [per-host manifest] →
  [conversation] with breakpoints; watch invalidation triggers (manifest
  bumps, Anthropic speed-mode switches, byte-level drift on OpenAI). Provider
  matrix and seam placement in §1.2.
- **Anthropic fast mode** (Feb 2026 research preview): up to 2.5x OTPS on Opus
  4.8/4.7 at premium pricing ($10/$50 per MTok on 4.8), OTPS only (NOT TTFT),
  and fast/standard do NOT share cache prefixes. Niche fit: tier-3 interactive
  first-generation only, whole-session or not at all.
- **Reasoning modes are the TTFT killer**: GPT-5.5 high ~29.8s TTFT vs 0.34s
  for Gemini 2.5 Flash-Lite. Interactive module paths use non-reasoning or
  minimal-effort settings, always with streaming progressive render.
- **Speculative decoding / Predicted Outputs** (EAGLE-3/3.1 4–5x on coding;
  OpenAI Predicted Outputs 3–5x on rewrites) are strictly dominated by our
  hunk protocol, which doesn't emit unchanged tokens at all. Use them only as
  the big-rewrite fallback lane.
- Latency arithmetic to keep in mind: a 4,000-token index.tsx ≈ 67s at 60
  tok/s, ≈ 8–10s at 400–500 tok/s, ≈ <2s as a 300-token diff at any provider.
  Output-length reduction is the highest-leverage, provider-independent win.

## 7. Runtime — the sandbox latency ladder

Source: `apps-speed/runtime.md`.

- **The ladder is ~an order of magnitude per rung**: V8 isolate ~5ms →
  Firecracker snapshot restore 3–30ms (managed: Daytona ~90ms, E2B ~150ms,
  Modal sub-second) → microVM boot <125–400ms → container platform 1–3s →
  Nixpacks image build ~90s (Railway's own data: ~1m27s vs 15s Dockerfile vs
  6s prebuilt; Railway is abandoning Nixpacks for Railpack over unpredictable
  caching, worth tracking).
- **Tier 2 bundles server-side with native esbuild** (module-sized inputs are
  single-digit-to-tens of ms with persistent rebuild contexts); esbuild-wasm
  is officially ~10x slower, never in-browser. Shared long-cached react/vendor
  bundle keeps per-module bundles KB-sized. Budget: ≤150ms cold, ≤50ms edit.
- **Tier 2.5 (proposed) V8 isolates** for JS-only server logic: Cloudflare
  Dynamic Workers (open beta 2026-04, $0.002/unique-worker-day) instantiate
  isolates from dynamically supplied code, exactly the mid-conversation shape;
  self-hosted `workerd` is the OSS-friendly equivalent. Tier 3's
  Python/bash/anything cannot run there; this is an optional escape hatch.
- **Tier 3: snapshot-restore, not boot, is the operative number.** Build async
  at publish/save time, snapshot after first successful boot, key the snapshot
  on the envelope's `version`. Any module edit invalidates the snapshot (Fly's
  deploy caveat generalizes), so edit turns hot-swap interpreted files inside
  the snapshotted environment and only re-run Nixpacks on dependency changes:
  the tier-3 analog of remix fast-edits.
- **Warm-pool economics favor buy over build**: pre-boot pool → snapshot →
  restore-per-request is exactly E2B/Daytona's business; self-hosting
  Firecracker pools is a predictive-autoscaling + idle-cost problem Vendo OSS
  shouldn't own. Avoid 25ms nsjail-class providers whose speed comes from a
  weaker isolation boundary.

## 8. Edit loop — the in-repo precedent and its generalization

Source: `apps-speed/editloop.md`.

- **The 32s→4.4s win moved work, it didn't speed inference**: the model emits
  only line hunks against a server-held hash-pinned baseline
  (`edit-view-tool.ts`, `remix/hunks.ts`, `remix/baseline.ts`);
  coordinate-mode addressing skips quoting old text; single-line JSON strings
  structurally kill the control-char truncation bug; mismatches echo actual
  lines for one-turn retries; prepared baselines move the mechanical glue to
  build time.
- **The hunk/baseline core generalizes mechanically; the rest does not**:
  per-file `baseHash` can literally be the git blob OID, the server-held base
  is repo HEAD, an applied op is a commit (provenance envelope → commit
  metadata), and prepared baselines become (a) deterministic build-time
  scaffold prep and (b) retrieval of accepted modules as edit bases so first
  generation is itself an edit. That transplant plus
  `addFile`/`deleteFile`/`renameFile` ops is rec #8's M. Explicitly NOT a
  transplant (the L-class follow-up): cross-file import/typecheck gates
  (generated view components are deliberately isolated blob modules today —
  real multi-file imports are new machinery), per-file + per-repo size
  budgets, and the "patched → building → swapped" progression for tier 3's
  async build. Concurrent-edit conflict policy in §1.7.
- **Cursor's objection to diffs (models botch line numbers) does not apply**:
  the server, not the model, resolves coordinates against a hash-gated base.
  Our hunks are strictly cheaper than aider search/replace blocks, and aider's
  evidence says edit format is a per-model tuning knob anyway (keep the
  coordinate vs exact-match dial).
- **Fast-apply models are a shrinking window** (June 2025: Morph and Relace
  founders both conceding "maybe six months" before frontier models master
  structured edits natively; Morph v3-fast 10,500 tok/s ~96–98% $0.80/M,
  Relace Apply 3 10k tok/s used by Lovable/Codebuff/Tempo). Slot
  Morph/Relace/Predicted-Outputs behind ONE optional materializer seam for big
  rewrites only, never a hard dependency. edit_view already IS the predicted
  end-state architecture (frontier emits structured edits + deterministic
  server apply, no silent merges).
- **Per-file regen vs whole-repo is settled**: specify as hunks, materialize
  per file, rebuild only touched files/layers; full-file regen is a fallback
  for small files (<~400 lines per Cursor) after two hunk failures; whole-repo
  regen only on explicit start-over.
- **Lesson from the live regression**: speed wins regress silently. Put
  `VENDO_BENCH`-class timings under benchmark assertions (rec #1, methodology
  §1.1).

## 9. Capability — what turns "generates UI" into "ships features"

Source: `apps-speed/capability.md`.

- **Self-healing is the leaders' #1 capability lever, and it's tiered**: v0
  layers mid-stream deterministic fixes (~100–250ms, icon-swap via embedding
  search in ~100ms) plus a fine-tuned autofix model (93.87% error-free
  generation — **Vercel self-reported, UNVERIFIED** per capability.md);
  Lovable's agent loop cut build errors 90% (self-reported); Replit Agent 3
  runs a browser self-test subagent at a median $0.20/session. Maps directly
  onto our split: tier-1 schema-repair (rec #12's in-stream ladder; structured
  outputs are the upstream fix) → tier-2 bundle-error autofix loop in the
  sandbox → tier-3 sandbox self-test subagent on warm snapshots.
- **Fail-closed catalog verification separates demos from shipping**: v0
  Design Systems 2.0's rule is "if a component, prop, or token cannot be
  verified from the sources, do not use it", every generation starting from a
  pre-reviewed starter app. Our zod descriptors make the same enforcement
  cheap at view-tree validation time; per-host starter scaffolds do it for
  tier 2/3 (correct-by-construction providers/theme/fonts).
- **Live data = path binding, not snapshots**: A2UI v0.9 binds components to
  JSON-Pointer paths and patches via `dataModelUpdate` without regenerating
  UI. Our 60s reads-only refresh is the v1; declarative binds are the
  standard-shaped v2 and inherit the guard layer for free. (Pairs with rec #5:
  data-by-reference at generation time and at refresh time are one design —
  including §1.4's transform/validation/staleness contract.)
- **Generation memory is a proven 50–80% head start** (Lovable
  remix/templates, v0 RAG + curated samples): retrieve a prior known-good
  module and edit it. Our git-repo modules + 4.4s remix fast-edits make
  retrieval-into-remix nearly free: embed shipped modules per host, retrieve
  top-k for similar intent, hand the best as the edit base. Retrieved modules
  already passed the guard layer and bind to real host tools, so it's a
  quality win too.
- **Descriptor ergonomics compound**: flat adjacency lists as generation
  targets, per-component when-to-use/anti-pattern/display-mode guidance
  (OpenAI Apps SDK enforces inline-card max-2-actions taxonomies and "the tool
  response contains everything the widget needs"), catalog shipped as a
  registry-like payload. Cheap upgrades to our one-line prompt-catalog lines.
- **Google's A2UI-vs-MCP-Apps split independently validates the tier-1/tier-2
  architecture** (published 2026-06-17): declarative catalog UI for structured
  data, sandboxed iframes for state-intensive custom modules, official hybrid
  patterns.
- **UI eval SOTA**: deterministic gates + screenshot MLLM-judge with per-task
  checklists scored pairwise (ArtifactsBench: 94.4% ranking consistency with
  WebDev Arena), but WebDevJudge shows LLM judges cannot verify functional
  correctness; that still requires execution, i.e. the self-test loop. This is
  rec #11, wired as a module-quality layer on the existing nightly corpus
  jobs; it doubles as the monogram-style variation-scoring loop that lets a
  smaller tier-1 model hold quality — and it gates rec #6's model swap.

---

## 10. What we deliberately do NOT do (or defer, with triggers)

| Rejected / deferred | Why |
|---|---|
| **In-browser bundling (esbuild-wasm / WebContainers)** | esbuild-wasm is officially ~10x slower than native; WebContainers are proprietary, heavyweight, and tier 3 exists precisely so server code runs server-side. Server-side native esbuild is ms-class already (runtime §Tier 2). |
| **A standalone fast-apply model dependency (Morph/Relace) in the core path** | Two-model pipelines fail silently; both vendors' founders concede a ~6-month viability window as frontier models master structured edits. Optional materializer seam only (editloop §2.5). |
| **Self-hosted Firecracker warm pools** | Predictive autoscaling + idle-cost is E2B/Daytona's whole business; Vendo OSS shouldn't own it. Buy, don't build (runtime §warm pools). |
| **nsjail-class "25ms" sandbox providers** | The speed comes from a weaker isolation boundary; unacceptable for untrusted AI-generated code (runtime table). |
| **Streaming React components (AI SDK RSC/streamUI)** | Officially experimental, "not recommended for production"; the industry settled on streaming declarative data against a client catalog, which is what view.json already is (genui-sdks §2). |
| **Per-module / per-request dynamic JSON schemas** | Every novel schema re-pays the grammar-compile penalty (up to 60s on OpenAI). One stable pre-warmed per-host catalog schema (genui-sdks §6, inference §7). |
| **Anthropic fast mode as a general speed lever** | Opus-only, premium ($10/$50), improves OTPS not TTFT, and splits the prompt cache between speed modes. Tier-3 interactive first-gen only, if at all (inference §3). |
| **Reasoning models on interactive paths** | ~29.8s TTFT (GPT-5.5 high) is disqualifying; reserve deep thinking for tier-3 planning behind progress UI (inference §8). |
| **Nixpacks builds anywhere near the conversational path** | ~90s average vs a ~5s feel budget is fatal; async at publish/save, warm snapshot as the cache (runtime §Tier 3). |
| **Whole-repo regeneration as an edit path** | No production system does it; hunks → per-file materialization → touched-file rebuild; whole-repo only on explicit start-over (editloop §2.6). |
| **Building on AI SDK's default partial-JSON parser for module-sized specs** | O(n²) re-parsing, ~6s at 100KB in third-party benches — though UNVERIFIED whether AI SDK 5/6 has since fixed it internally; bench the current version (10 minutes) before choosing a parser. Default plan: an O(n) incremental parser (genui-sdks §2, §7). |
| **A learned routing classifier** | The tier ladder plus deterministic validation-failure escalation already is the router; RouteLLM-class savings without the ML (inference §6). |
| **Flat view.json v2 (A2UI-style JSONL encoding) — DEFERRED, with a trigger** | The single biggest protocol change available (§5), but it breaks the view.json contract everywhere at once: shell/stage renderer, prompt-catalog lines, 10+ corpus repos of pass@2 fixtures, persisted modules in `@vendoai/store`, and the remix baseline format. Migration would need a dual-decode window + full corpus regeneration (L-class). Revisit trigger: if rec #4's O(n) parser + schema key-order still misses the §2.1 tier-1 first-paint p50 (≤1.5s), flat encoding is the next lever and gets a costed spec. |
| **Fine-tuning / distilling a dedicated tier-1 generation model — DEFERRED, with a trigger** | Monogram's "core UI generation model" and v0's RFT-trained autofixer show the ceiling, but training before an eval loop exists is uncheckable. Deferred until rec #11 is live and the prompt-level levers (recs #4–6) are exhausted. Revisit trigger: a Haiku/Flash-class model fails rec #11's quality gate at the §2.1 latency targets — then distillation is the remaining move. |
| **Copying monogram's native-renderer bet wholesale** | Their zero-sandbox speed applies only to catalog UI; giving up tiers 2/3 would surrender the capability moat that is our actual differentiation vs a $40M-funded speed play (monogram §4). |
| **LLM judges as functional verifiers** | WebDevJudge: judges can't verify working-app correctness; ranking/regression only. Functional claims require execution (capability §6). |

---

## Appendix: source reports

- `apps-speed/monogram.md` — monogram.ai teardown (scratchpad, 2026-07-10)
- `apps-speed/products.md` — v0/Bolt/Lovable/Artifacts/Canvas teardown
- `apps-speed/genui-sdks.md` — gen-UI SDK + protocol survey
- `apps-speed/inference.md` — inference SOTA
- `apps-speed/runtime.md` — sandbox/runtime latency spectrum
- `apps-speed/editloop.md` — edit-turnaround SOTA + in-repo precedent
- `apps-speed/repo-audit.md` — where time goes at HEAD `3c32f2ba`
- `apps-speed/capability.md` — capability levers
- `docs/specs/research-2026-07-module-speed.md` (2026-07-10, solo survey)
- `docs/specs/research-2026-07-framework-landscape.md` (protocol/SDK facts)

Note: the scratchpad reports are session-local; if this doc is the only
artifact that survives, every load-bearing claim above carries enough of its
original source citation to re-verify.
