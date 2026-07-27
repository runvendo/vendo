# genui-bench: the generation iteration playground

**Date:** 2026-07-26 · **Approved by:** Yousef (brainstorm session)
**Mockup:** reviewed clickable mockup (four-pane cockpit); archived copy at
`docs/superpowers/specs/assets/2026-07-26-genui-bench-mockup.html`

## Purpose

The missing inner loop for the micro-app format and generation pipeline:
change a prompt/contract/guardrail in the working tree → run a prompt →
see the rendered result in seconds, side by side with past runs and with
competitor products (Thesys C1, CopilotKit, Tambo) on the same prompt.

Positioning against existing tooling:
- `docs/eval` GOLDEN/REMIX — frozen outer truth, not for iteration.
- Corpus nightlies — extraction/init quality, not generation.
- Self-improving eval suite (separate active brainstorm) — automated
  outer loop with judging. genui-bench is the *human* inner loop and
  deliberately has **no judging**: Yousef's eyes are the judge. The only
  automatic classification is generated-cleanly vs errored.

Users: Yousef interactively (primary tempo) and agents headlessly — one
runner core, two thin callers.

## Architecture

```
apps/genui-bench/            private workspace app — never published/deployed
├─ runner/       {prompt|pack, host, lanes[]} → RunRecord  (library)
├─ lanes/        vendo.ts · thesys-c1.ts · copilotkit.ts · tambo.ts
│                each: generate(prompt, hostContext) → LaneResult
├─ cockpit/      dev-server UI (four panes, history rail, internals drawer)
├─ cli.ts        pnpm genui-bench run … → RunRecord path + JSON summary
└─ runs/         RunRecords on disk (gitignored)
```

Load-bearing decisions:
1. **Runner is a library; cockpit and CLI are both thin callers.** One
   generation code path for human and agent use.
2. **Live working tree.** The app imports `@vendoai/apps` engine and
   `@vendoai/ui` renderer from workspace source with dev-server watch. No
   build step in the loop; a Cursor edit is live on the next run.
3. **Host contexts are fixtures, not live servers**: the existing bench
   `demo-bank-surface.ts` pattern (real tool catalog, real theme, canned
   tool data), extended with a Cadence surface. Deterministic-ish, fast.
   Fixture tools are EXECUTABLE, not just cataloged — the rendered app's
   queries and actions run against them at view time, so the Vendo pane
   exercises the full generate → render → interact → tool-call loop.
4. **Competitor SDKs quarantined** in this app's package.json only.
   Dependency-guard and published packages never see them.
5. **RunRecord is the atom.** History, pinning, split-compare, and agent
   evidence are all reads over RunRecords.
6. **Engine internals via the existing `PipelineEvent` stream** — tap it,
   don't add engine instrumentation unless a real gap appears.

## Cockpit (mockup approved)

- **Top bar:** host picker (Maple/Cadence); git-state indicator — SHA +
  dirty marker + last-touched engine file, so the code state of the next
  run is always visible.
- **Prompt row:** free-text prompt; Packs dropdown (smoke ~3 / standard
  ~10 / stress ~8; current prompt can be saved into a pack); per-run lane
  toggle chips; Run. Packs are committed files under
  `apps/genui-bench/packs/` (versioned, shared with agents) — unlike
  `runs/`, which stays gitignored.
- **History rail:** runs newest-first (prompt, time, SHA, duration);
  pinned runs surfaced with ★; click = load run read-only; ⌥-click =
  split-compare vs current.
- **Four panes:** the Vendo pane is the REAL RUNTIME, fully interactive
  (Yousef addition 2026-07-26): the generated app runs — its tool calls
  execute against the fixture host's tool implementations (canned data)
  through the real ToolRegistry/guard path, actions fire, `$state` and
  islands work, and you click around the app exactly as an end user
  would. Rendering uses the exact production Kit components and
  `@vendoai/ui` renderer — no approximations. Competitor panes render
  with their own SDKs/themes (honest, not re-skinned). Pane header:
  status dot, wall-clock, repair count. Pane footnote states the lane's
  asymmetry (see Lanes).
- **Internals drawer:** Vendo `PipelineEvent` timeline humanized
  (outline → stream → compile → guardrail verdicts → repair rounds →
  smoke render → done + cost); tabs for raw wire text, final AppDocument
  JSON, and each competitor's raw request/response.

## Model controls (Yousef addition 2026-07-26)

Playing with the model is part of the loop, so model choice is a
first-class run input, not an env var.

- **Scope: Anthropic models + sampling.** Per-run picker across the
  current Claude line (Fable 5, Opus 5, Sonnet 5, Haiku 4.5) plus
  temperature and thinking-budget controls. Multi-provider was
  considered and declined for v1: extra deps/keys, and the contracts are
  Claude-tuned so cross-provider results would mislead.
- **Where:** a model control in the cockpit prompt row (collapsed by
  default, remembers last choice) and CLI flags `--model`,
  `--temperature`, `--thinking`.
- **RunRequest gains** `model?: {id, temperature?, thinkingBudget?}`;
  RunRecord therefore stamps it, so history shows which model produced
  which app and split-compare doubles as a model A/B.
- **Applies to the Vendo lane** (the engine under study). Competitor
  lanes keep their own model defaults — their pane footnote states the
  model they used so comparisons stay honest.
- Default = the engine's production default model, so an untouched run
  measures what ships.

## Runs, history, pinning

- `runs/<id>/run.json`: prompt, host, timestamp, git SHA + dirty-diff
  hash, per-lane {status, duration, cost}, pin label.
- Per-lane artifacts alongside: Vendo wire text + AppDocument + event
  log; competitors' raw request/response JSON. Plain files, gitignored.
- **Pinning** = writing a label into run.json ("baseline", any string);
  multiple pins coexist; pins sort first in compare pickers.
- **Split-compare** is read-only: Vendo pane renders both documents side
  by side; drawer aligns both event logs. No automated diffing in v1 —
  eyes diff the UI, aligned internals explain the why.

## Agent path

`pnpm genui-bench run --host maple --pack smoke --lanes vendo` → same
runner, prints RunRecord path + compact JSON summary (per prompt:
ok/failed, duration, repair count, guardrail events). Agent loop:
edit → run smoke → read summary → repeat; RunRecord paths are PR
evidence. Agent runs appear in the cockpit history rail automatically
(same runs/ dir).

## Lanes

Common interface `generate(prompt, hostContext) → LaneResult`; each
adapter ~100 lines; lanes run concurrently; keys from the root `.env`
(canonical key file). Missing key → pane shows "no key", run proceeds.

- **Thesys C1** — closest comparable: prompt + our tool catalog
  (translated to their tool format) → their API → rendered with their
  React SDK. True same-prompt-in, generated-UI-out.
- **CopilotKit** — registered-components paradigm: small fixed harness
  with domain components (chart, table, form) + same tools; the pane
  shows how their runtime drives predefined components on the same ask.
- **Tambo** — same family as CopilotKit (component registry + AI
  orchestration); same harness treatment. Verify current API shape at
  build time (young product).
- Footnote rule: every competitor pane permanently states its asymmetry
  so a weak pane is never misread as a weak product.

## Failure handling

- Lanes isolated: a lane error (API down, engine crash) marks that pane
  failed with the error captured; the run always completes and persists.
- A Vendo generation dying mid-pipeline still writes its partial event
  log — failed runs are first-class study objects.
- Runner never throws to the cockpit/CLI; it returns a RunRecord with
  per-lane status.

## Testing

- Runner + persistence: real tests with fake lane adapters, zero model
  calls.
- Cockpit: boot smoke test rendering a canned RunRecord.
- Competitor adapters: contract tests against recorded fixtures; no live
  API calls in CI, ever.
- Repo gates unaffected beyond one new private workspace in
  build/test/typecheck/lint.

## Non-goals (v1)

- No judging/scoring of any kind (Yousef ruling: his eyes only).
- No automated document diffing in split-compare.
- No deployment; localhost only.
- No editor — Cursor/agents edit; the playground only reflects.
- Not absorbed into the eval suite; if the eval suite later wants the
  lane adapters or packs, it imports them, not vice versa.

## Delivery (ASAP mandate, 2026-07-26)

Four parallel lanes after spec sign-off: (1) runner + RunRecord + CLI,
(2) cockpit UI, (3) Vendo lane + PipelineEvent tap + fixtures (Cadence
surface), (4) competitor adapters + harnesses. Sequencing rule: a
Vendo-only playground ships first; competitor panes land behind it.
Yousef items: Thesys/Tambo accounts + keys when lane 4 needs them.
