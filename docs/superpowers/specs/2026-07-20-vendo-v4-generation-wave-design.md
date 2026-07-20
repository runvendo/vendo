# v4 generation wave — fix the fails, raise the looks

**Status:** simplified after Yousef review 2026-07-20 (first draft was a 6-lane program; most
fixes turned out to be one-liners or existing flags).
**Baseline:** final gate 18/30 + 8/10 (`docs/verification/final-gate/`), rules in `docs/eval/`.

## The fixes (one per fail class, smallest sufficient mechanism)

| Fail class (gate evidence) | Fix | Size |
|---|---|---|
| Island runtime errors / blank apps ×5–6 (C4, C8, M4, M10, F3) | **Smoke-render gate**: execute each island headless before ship; failure feeds the existing repair loop, exhausted repair → honest disclaimer card | The one genuinely new mechanism this wave |
| Wrong headline bindings ×3–4 (M6, M14, F5, M1 blemish) | **Turn on the end pass** (exists, flagged off — `pipeline.ts`) with a headline label-vs-binding focus in its read-through | Flag + prompt focus |
| False empty from hardcoded year (M9) | **Put the current date in the prompt** (there is no clock in it today) | One line |
| Group filter unwired (C3) | Prompt line; tiny lint only if the prompt doesn't hold on dev prompts | Small |
| Capability claims (M5, M15) | Prompt lines (honesty handling already passes 7/8 impossibles) | Small |
| Fabricated derived values (M12 FX) | Law 1 extension: a constant feeding displayed math must trace to a tool, else disclaimer arm | Small validator change |
| Latency tail invisible (54–95s dead air) | **Wire the existing streaming into the Apps page** — tier-0 paint (haiku, demo-bank already configures it) + partials only run on the chat path today; `POST /apps` is blocking. Plus a repair indicator off the existing `onPipeline` events | Plumbing, no engine work |

## Design

- **Author `.vendo/design-rules.md` for both demo hosts** — the prompt seam exists
  (`HOST DESIGN RULES:`) and both hosts currently generate with "(none provided)".
  Layout discipline, hierarchy, density, brand usage (serif headlines on Maple, etc.),
  humanized enums.
- **Measure design as pairwise old-vs-new**: same prompt, gate screenshot vs the
  2026-07-20 baseline screenshot, VLM judged in both orderings. (Research: pairwise is
  the reliable VLM judging mode; absolute rubric scoring is not — ArtifactsBench
  2507.04952, MLLM-as-UI-Judge 2510.08783.)
- **Kit layout primitives only if the prompt plateaus** — judged on dev prompts with the
  same pairwise judge before building anything.

## Deferred (revisit only with evidence)

Per-prompt design checklists · composition stage in outline · Kit layout primitives
(conditional above) · region-parallel · screenshot-critique pass · external anchors
(UI-Bench vs v0) · CFG/owned serving.

## Execution

2–3 PRs on one branch, no lane program:
1. Cheap fixes: prompt clock + prompt lines + law-1 extension + end pass on + design-rules.md.
2. Smoke-render gate.
3. Apps-page streaming + repair indicator (browser-verified with screenshots per repo rules).

Verify on NEW dev prompts (burned per GOLDEN rule 4). Gate once at the end: frozen 30 +
fresh Tranche 3 (authored blind) + pairwise design vs the 2026-07-20 screenshots.

## Success criteria

- Frozen 30 above 18/30 with the empty/broken-render class at zero; fresh bar held.
- Pairwise design: new wins a clear majority vs baseline screenshots.
- Apps page shows paint/progress within ~5s; repair visible when it engages.
