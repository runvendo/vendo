# W1 — Format measurements: VERDICTS

Lane W1 of the Vendo v3 build. Authority: `docs/superpowers/specs/2026-07-19-vendo-v2-general-quality-design.md` §"Reliability mechanisms — Measure". Downstream lanes read this file.

## How to read this

- **Domain / fixtures:** one realistic host ("Maple", a bank/AP host) — cents money, ISO dates, enum statuses, nested client objects, read + write tools. Shapes are DERIVED from sample rows (the `vendo sync` path). See `packages/apps/src/bench/fixtures.ts`.
- **Prompts:** ~18 lane-authored dev prompts (+3 negatives for Exp3). These are NOT the frozen 30-prompt held-out corpus — that set is never touched here.
- **Generator model:** `claude-sonnet-4-6` (the production full-lane model — the model downstream decisions apply to). A/B arms always share it.
- **Judge model:** `claude-opus-4-8` (independent, stronger — avoids self-preference bias). Blind to arm.
- **Compiler:** every metric is computed from the REAL production compiler `compileWireV2` with the fixture tool shapes — compile-ok, binding-shape errors, unknown tools/components, declared-but-unused are the compiler's own verdicts, not a re-implementation.
- **Significance:** small n (18–21/arm). "outside noise" = |mean-quality difference| > 2× combined standard error (~95%). A null result is reported honestly as a null.
- **Reproduce:** raw per-sample JSON in `raw/exp{1,2,3}.json`. Re-run with `ANTHROPIC_API_KEY` set: `pnpm --filter @vendoai/apps exec vitest run src/bench/exp{N}.bench.test.ts`.

Metric glossary: **compile-ok** = complete parse, no hard-structural issue, non-empty. **ref-error-free** = compile-ok AND zero wiring errors (binding-shape + unknown tool/query/component + invalid action). **mean binding-err** = mean count of `bindingErrors` (wrong field path vs the known shape) — the v2 unshippable gate. **format-miss** = a cents/date value shown to a user without a format step. **fabrication** = judge saw business data not traceable to a tool.

---

## Experiment 1 — inline tool refs vs `<Query>` declarations — **ADOPT (inline)**

Arm A emits `<Query>` declarations + plain bindings (today's dialect). Arm B writes inline references (`rows={invoices.list({status:"overdue"}).data}`); the `inlineRefs` compiler prototype (`packages/core/src/wire-v2/inline-refs.ts`, behind `compileWireV2({inlineRefs:true})`) mints the query and dedupes by tool+args. Unit tests prove the two arms compile to a byte-identical canonical tree.

| arm | n | compile-ok | ref-error-free | mean ref-err | mean binding-err | declared-unused | format-miss | fabrication | answers-ask | mean quality (sd) | p50 out-tok | p50 latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A: `<Query>` decls | 18 | 100% | 33% | 1.33 | 0.56 | 11% | 0% | 0% | 100% | 3.72 (0.80) | 367 | 6.6s |
| B: inline refs | 18 | 94% | 39% | 1.28 | 0.17 | 22% | 0% | 6% | 100% | 4.17 (0.76) | 421 | 5.7s |

Quality difference (A−B): −0.44 ± 0.52 → **not outside noise**.

**Verdict: ADOPT inline refs.** No reliability regression (compile-ok 94% vs 100% is one sample, within noise), materially fewer binding-shape errors (0.17 vs 0.56), and equal-or-better judged quality — but nothing is outside noise, so this is a **tie on the measured axes**. Per the lane rule *ties → inline (simpler)*, adopt inline: it removes the declare-then-reference indirection and the "declared-but-unused" failure mode is a non-issue when the compiler mints queries. Keep the `<Query>` path supported (the compiler still accepts it; inline is a pre-transform). Caveat: `ref-error-free` is low for BOTH arms (33–39%) — the model over-binds one field per app on average regardless of surface; that is a base-prompt/model property the surface choice does not fix (it is what structured repair, separately ADOPTED by the spec, exists for).

---

## Experiment 2 — builder-calls fork — **DEFER (composition survives + reliability wins, but 6× latency disqualifies it on today's API)**

Arm A: current single-stream JSX. Arm B: the app is emitted as strict builder tool calls — `set_query`, `begin_region`/`end_region` (order-based nesting), one `place_<Component>` tool per prewired/catalog component (constrained component + prop names), `define_island`, `finish` — with extended thinking ON (think-then-constrain). The call stream is reconstructed into wire and run through the identical compiler+metrics path. `packages/apps/src/bench/toolfork.ts`.

**Methodology note (important):** the spec's "all in ONE assistant turn" does not map onto the tool-use protocol — a model emits a *batch* of tool calls, then pauses for results before continuing. A literal single-turn capture yields ~1.3 calls/app and a broken app (measured, first run). The fair test runs the tool loop feeding no-op acknowledgements so the model composes the whole app across steps; the numbers below are that corrected run.

| arm | n | compile-ok | ref-error-free | mean ref-err | mean binding-err | declared-unused | format-miss | fabrication | answers-ask | mean quality (sd) | p50 out-tok | p50 latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A: single-stream JSX | 18 | 89% | 33% | 0.89 | 0.39 | 17% | 6% | 6% | 100% | 3.94 (0.85) | 427 | 6.7s |
| B: builder tool calls (+thinking) | 18 | 100% | 65% | 0.47 | 0.29 | 0% | 0% | 0% | 100% | 4.35 (0.59) | 158 | 44.4s |

Mean tool calls/app (fork): **14.1**. Quality difference (B−A): +0.41 ± 0.49 → **not outside noise**. (The fork's p50 output-tokens of 158 is the *final step only*; cumulative output across ~14 calls plus context re-sent every step makes the fork substantially more expensive in total tokens than the single stream — the small final-step number is not the cost.)

**The go/no-go question — does composition survive many discrete calls? — is answered YES.** At 14.1 constrained calls per app the fork produced *better* structure than the JSX stream: ref-error-free jumped to 65% (vs 33%), compile-ok to 100%, and declared-unused / format-miss / fabrication all to 0% — with equal-or-better judged quality (4.35 vs 3.94, not significant). Constraining names + structured props genuinely removes several error classes.

**Verdict: DEFER.** The disqualifier is **latency: 44.4s vs 6.7s (~6×)**, an unavoidable consequence of sequential tool round-trips — it blows the spec's "complete ~6s" target by 7× and is incompatible with the streaming paint→complete UX the pipeline is built around. Total token cost is also materially higher. So: the *reliability* thesis of the fork is validated, but the *delivery mechanism* (hand-authored tools over a hosted chat API, one round-trip per batch) is wrong. The same unsamplable-name / structured-field guarantee is delivered in a **single pass** by grammar-constrained decoding (Experiment 4) at owned-serving time — that is where this reliability win should be banked, not in a 44s tool loop. Revisit the fork only if parallel/batched tool emission or owned serving removes the round-trip tax; do not adopt it as the generation path now, and do not discard the reliability signal it produced.

---

## Experiment 3 — fetch-then-generate vs shape-cards-only — **DEFER**

Arm A: today — shape cards (tool response shapes) in the prompt. Arm B: phase-1 no-think call selects read tools+args → runtime reads them (simulated from fixtures, truncated to 2–3 rows + rowCount) → phase-2 generation additionally sees each tool's real args, shape, rowCount, and sample rows. Negatives (no tool for the ask) probe honesty. `packages/apps/src/bench/exp3.bench.test.ts`.

| arm | n | compile-ok | ref-error-free | mean ref-err | mean binding-err | declared-unused | format-miss | fabrication | answers-ask | mean quality (sd) | p50 out-tok | p50 latency |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A: shape cards | 21 | 100% | 48% | 1.10 | 0.57 | 14% | 0% | 5% | 86% | 3.86 (0.94) | 298 | 5.4s |
| B: fetch-then-generate | 21 | 81% | 38% | 1.14 | 0.00 | 24% | 5% | 5% | 81% | 4.05 (1.05) | 285 | 5.3s |

Quality difference (B−A): +0.19 ± 0.61 → **not outside noise**. Negatives fabricated — cards 0/3, fetch 0/3 (no honesty difference; both disclaim). Latency for B counts phase-2 only; the true complete-time is worse by one phase-1 call.

**The one real signal:** fetch-then-generate drives **binding-shape errors to 0.00** (vs 0.57 for cards) — seeing real fields eliminates the field-reference class outright. But it does NOT beat cards outside noise on quality, adds a phase-1 round-trip, and **regressed compile-ok to 81%**. That regression is concentrated: 3 of the 4 failures are the negative prompts, where an empty fetched block made the model drift to a **prose refusal instead of a `Disclaimer` component** (cards handled the same negatives as clean Disclaimers); the 4th is one bar-chart page. On the 18 positive prompts, fetch is 94% compile-ok (17/18) with 0.00 binding errors.

**Verdict: DEFER** (spec rule: adopt only if it beats cards outside noise — it does not). The binding-error elimination is the reason this is DEFER, not REJECT. Revisit when paired with (a) the pipeline's structured-repair + end-pass (already ADOPTED in the spec) to catch the compile drift, and (b) a phase-2 prompt that forces the `Disclaimer` component on an empty fetch. If those close the compile-ok gap, the 0.00 binding-error result makes it a likely adopt for data-dense apps.

**Revisited 2026-07-21 under the v4 create contract** — see
`fetch-then-gen-v4-revisit.md`: the compile regression is gone (100% both
arms, negatives 4/4 honest Disclaimers), the binding-error win is moot (v4
blind is already 0.11/app), and the live axis is now label-truth, where fetch
cuts the data-ignorance lie classes roughly in half but stays inside noise at
n=20. Upgraded to ADOPT-CANDIDATE with revisit conditions in that file.

---

## Experiment 4 — llguidance CFG-JSX replay — **DEFER (grammar + protocol ready to run)**

Best-effort per the TASK. **No GPU/open-weights serving infra available without buying it** (Modal deleted; e2b is not a GPU inference path; ≤2h infra budget). Per the TASK this is a graceful SKIP-live: the grammar and the run protocol are delivered ready-to-execute.

Deliverable: `docs/verification/w1-bench/wire-subset.lark` — a Lark CFG for a subset of the vendo-genui/v2 wire, specialized to the Maple catalog. It fixes the terminals to one host so component names, prop names, tool names, and format enums are drawn from closed sets: an invented component, a wrong prop, or a hallucinated tool becomes **unsamplable at the keyboard** — the whole "invented component / wrong prop / hallucinated tool" class is structurally impossible, not repaired after the fact. (Binding field-path *values* are left as free identifiers here; a full field-path CFG enumerating each tool's shape is the noted mechanical extension.)

**Verdict: DEFER** — this is the endgame moat (grammar-constrained JSX at owned serving), not adoptable on the current hosted API. It is the evidence line for owned serving, kept ready to run.

### Ready-to-run protocol (≈1 day once a GPU is available)
1. **Serve** an open-weights model with grammar support: vLLM (`--guided-decoding-backend xgrammar`) or SGLang, on any available GPU (Modal/e2b-GPU/cloud with existing creds). Qwen2.5-Coder-7B/32B-Instruct is a good first target.
2. **Grammar:** load `wire-subset.lark`; adapt whitespace/`%import` to the runtime's Lark dialect. Optionally regenerate the terminal sets from a host registry so the grammar tracks the catalog.
3. **Prompts:** replay ~10 of the W1 dev prompts (`packages/apps/src/bench/prompts.ts` `DEV_PROMPTS`), same Maple context block.
4. **Two arms, same model, same prompts:** (A) free decode; (B) grammar-constrained decode.
5. **Metrics:** reuse `computeWireMetrics` (`packages/apps/src/bench/metrics.ts`) — compare compile-ok, unknown-component, unknown-tool, and binding-shape errors. Expectation: B drives unknown-component and unknown-tool to exactly 0 by construction; measure the residual (field-path) errors and any quality cost.
6. **Verdict rule:** grammar constraint is worth owned-serving investment if it zeroes the structural error classes with no material quality regression vs. free decode on the same model.

---

## Summary

| # | Experiment | Verdict | Key number |
|---|---|---|---|
| 1 | inline refs vs `<Query>` | **ADOPT (inline)** | tie; binding-err 0.17 vs 0.56, quality Δ −0.44 ± 0.52 (noise) → tie → inline |
| 2 | builder-calls fork | **DEFER** | composition survives (14.1 calls, ref-error-free 65% vs 33%, quality 4.35 vs 3.94) but latency 44.4s vs 6.7s (~6×) is disqualifying on today's API |
| 3 | fetch-then-generate vs cards | **DEFER** | binding-err 0.00 vs 0.57, but compile-ok 81% vs 100%, quality Δ +0.19 ± 0.61 (noise) |
| 4 | llguidance CFG-JSX | **DEFER** | no GPU infra; grammar + protocol delivered (`wire-subset.lark`) |

Downstream: Wave 5 should adopt inline refs (retire the declare-then-reference step); keep fetch-then-generate on the DEFER shelf behind repair + Disclaimer-forcing; do NOT adopt the builder-calls fork as the generation path now (its reliability win is real but the ~6× latency is disqualifying — bank that win via grammar-constrained decoding instead); hold grammar-constrained JSX (Exp4) for owned serving as the single-pass home for both the fork's name-safety and the CFG name-safety.
