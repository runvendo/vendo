# Vendo v4 generation wave — verified claims, visible progress, real taste

**Status:** APPROVED direction (brainstormed with Yousef 2026-07-20). Spec pending his review.
**Predecessor:** `2026-07-19-vendo-v2-general-quality-design.md` (v3, complete: final gate 18/30 frozen + 8/10 fresh, evidence `docs/verification/final-gate/`, front door `docs/eval/README.md`).

## Thesis

v3 made data provenance verifiable (two laws, structured repair, inline refs). The remaining
failures are a single phenomenon: **the app asserts things nothing checks** — code that claims
it runs but was never executed, labels that claim scope their bindings don't have, group
headers that claim filters they don't apply, copy that claims capabilities that don't exist.
v4 makes claims verifiable, never ships code it hasn't rendered, and moves design taste into
the system — wrapped in a progressive-sections UX where the quality gates ARE the reveal
choreography instead of added wait.

Two goals, one wave:

1. **Design ability** — generated apps look genuinely great (layout taste, hierarchy, polish,
   brand feel), not merely correct.
2. **Error backlog** — the ranked classes from the final gate: island runtime errors,
   wrong headline bindings, M12's fabrication, filter wiring, the latency tail.

## Evidence base (final gate, 2026-07-20, one attempt, zero tuning)

14 fails by class: empty/broken render ×5–6 (C4 onClick TypeError, C8 props scoping, M4 blank
iframe, M10 empty app, F3 missing body) · wrong headline binding ×3+ (M6, M14, F5, plus M1/M12
blemishes) · filter/time wiring ×2 (C3, M9) · capability claims ×2 (M5, M15) · derived-value
fabrication ×1 (M12 FX). Timing p50 19–24s, p95 74–95s, repair engages invisibly. Design
baseline (screenshots): clean but anonymous — unbalanced grids, dead space, raw enums,
two-line full-width cards; brand feel only where a host component or luck provided it (F9).

## Locked decisions (don't re-ask)

1. **Generation UX = progressive sections.** Outline emits a skeleton (title + labeled
   section placeholders + hierarchy) painting in ~3s; per-section writers fill it; a section
   swaps skeleton→content **only after passing its gates**; repair renders as per-section
   "polishing…"; exhausted repair degrades to an honest disclaimer card (never a blank
   region). Unverified *claims* are never shown; structure is shown immediately.
   Draft-then-refine (show unverified numbers, patch visibly) REJECTED — trust-destroying
   for financial data. Timing metrics become time-to-skeleton / time-to-first-section /
   time-to-complete; the "no error box" bar extends to "no dead skeleton".
2. **Ship gates, by failure class:**
   - *Smoke-render gate*: every section (islands especially) is executed/rendered headless
     before swap-in; render failures feed structured repair with the real error in the
     closed fix space. Kills the empty/broken-render class by construction.
   - *Claim-check*: labels/badges/captions/headers are claims about bindings — check
     headline scope vs binding scope, group headers vs applied filters, time headers vs
     data reality (false empties), copy vs actual tool capability. Violations feed
     structured repair.
   - *Derived-values law* (law 1 extension): a displayed number computed from a constant
     that traces to no tool call (M12's invented FX rate) is the same crime as a literal in
     a data slot → compile error → honesty-disclaimer arm.
3. **Design levers (all three structural levers now):**
   - *Layout primitives in the Kit* — composition components with taste baked in
     (PageShell / HeroStat / StatRow / SplitView / BoardColumn / DetailHeader — exact
     inventory decided inventory-first, as W2 did for the Kit). Grid discipline, spacing
     rhythm, density are the component's job; the model picks patterns, never invents
     geometry. Side effect: shrinks freeform island layout code, where runtime errors live.
   - *Composition at outline time* — outline decides hero / hierarchy / archetype
     (dashboard, detail page, board, form, report), not just section order. Same work as
     the skeleton emission.
   - *Brand activation + Kit polish* — accent-deployment and type-personality rules so
     apps look host-shipped (systematize F9's serif-headline moment); enum humanization
     tier in fmt/Kit (raw `missing_docs`/`s_corp` cells retire); designed empty states;
     the gate wart list.
4. **Design measurement = per-prompt checklists + pairwise.** (a) A design checklist per
   golden prompt, authored blind, frozen in GOLDEN.md, judged by VLM against screenshots —
   ArtifactsBench-style (checklist-guided MLLM judging: 94% agreement with human rankings;
   generic absolute rubric scoring REJECTED — 35–38% exact accuracy in the literature).
   UICrit critiques as judge calibration few-shots. (b) Old-vs-new pairwise per gate run,
   judged in both orderings (position bias), as the regression guard. External anchor
   (UI-Bench's released prompt set vs v0/Lovable) DEFERRED to a later wave.
5. **Screenshot-critique refine pass = experimental, flag-gated.** Post-complete, async
   ("refining design…"), bounded validated patches. Adopted only if it moves the
   checklist/pairwise numbers — W1-bench treatment, not a default stage.
6. **Latency posture:** best-UX framing, not a raw budget. Gates overlap the reveal
   (per-section, not serial-after-everything). Region-parallel verdict REOPENED — it was
   flagged off on total-latency cost, but under progressive paint the criterion is
   time-to-first-section. Repair/paint progress surfaced in UI.
7. **Execution = v3-style lane program** (orchestration file + parallel worker lanes with
   TASK.md briefs, self-triage + self-merge under standing authorization).

## Lane sketch (dependencies, not briefs yet)

- **W0 — outline skeleton + progressive engine/UI** (keystone; everything hangs off the
  skeleton schema and per-section lifecycle).
- **W1 — ship gates**: smoke-render, claim-check, derived-values law (builds on
  `.vendo/semantics.json` + structured repair; per-section wiring depends on W0).
- **W2 — Kit layout primitives + brand activation + polish debt** (independent start;
  inventory-first).
- **W3 — design-metric harness**: checklist authoring (blind, frozen), VLM judge +
  calibration, pairwise runner (independent start; needed before any design claims).
- **W4 — experimental screenshot-critique** (needs W0 post-complete hook + W3 judge).
- **W5 — fresh Tranche 3 authoring (blind) + FINAL GATE**: frozen 30 + F1–F10 + T3, run
  once on merged main, browser-judged, correctness + design axes, no fixes during the run.

## Verification discipline (unchanged doctrine)

Front door rules apply: develop against NEW dev prompts (burned to the DEV list), never
tune on frozen tranches, spend the frozen sets once at the final gate. Design numbers come
only from the W3 harness on gate runs. UI-affecting work is verified in a real browser with
screenshots in PRs.

## Non-goals / deferred

External design anchoring vs competitors; molds-from-traffic; CFG/owned-serving GPU day
(still the endgame latency lever — unblocked separately); reusing any fresh tranche as
fresh; design scores from anywhere but the harness.

## Success criteria

- Final gate: frozen 30 above 18/30 with the empty/broken-render class at zero; fresh
  tranche ≥ 8/10 bar held.
- Design axis: checklist scores recorded for all gate prompts; pairwise old-vs-new wins on
  a clear majority (both-orderings agreement).
- UX: time-to-skeleton ≤ ~5s on gate hardware; no dead skeleton; repair visible when it
  engages; zero blank regions shipped.

## Research references

ArtifactsBench (arXiv 2507.04952, checklist-guided MLLM judge, open code/dataset) ·
UI-Bench (arXiv 2508.20410, expert pairwise + TrueSkill, released prompt set) ·
UICrit (arXiv 2407.08850, designer critiques for judge calibration) ·
MLLM-as-UI-Judge (arXiv 2510.08783, pairwise > absolute; near-chance on small gaps) ·
WiserUI-Bench (position bias) · VisJudge-Bench (chart aesthetics).
