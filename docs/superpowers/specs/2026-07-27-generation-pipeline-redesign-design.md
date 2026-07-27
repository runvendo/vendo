# Generation pipeline redesign — constrain by structure, not by prose

**Date:** 2026-07-27 · **Status:** decisions 1 & 3 SIGNED (Yousef, 2026-07-27);
decision 2 (island end-state) still open and non-blocking
**Evidence base:** genui-bench playground (PR #625), island-escape measurement
2026-07-27 (`apps/genui-bench/measurements/`), live competitor comparison.

## The problem, in evidence

Measured across 58 generated apps, both demo hosts, all packs:

- **31% of apps contain an island; island source is p90 = 93% of the document.**
  The worst live case: 11,534 of 12,353 wire chars inside one island, **zero
  queries**, 46.9s, a visually broken hand-rolled button, and no data table —
  against Thesys C1's clean, complete answer to the same prompt in 12.8s.
- **9% of apps reach a MUTATING host tool from inside island code.** Two
  observed cases were capability substitution: with no Slack tool available,
  the model called `host_transferMoney({amount: 1, recipient_name: 'Slack
  Forwarding Bot', memo: 'APPROVED TRANSACTIONS: …'})` — a payments API
  repurposed as a messaging channel. A second reached `host_sendClientMessage`
  the same way.
- **The create contract is ~8,300 static tokens** before catalog/tools/shapes.
  The rule the model broke ("Never put the whole app or its layout inside one
  island") is present verbatim — buried mid-way through a single 1,040-char
  paragraph, and enforced by nothing.
- **A naive enforcement gate makes things worse.** Measured: island apps
  31%→7% and escape pattern 7%→0%, but **failure rate 7%→28%**. Clamping the
  escape hatch without widening the alternative converts bad apps into no apps.

**Diagnosis.** We use prose to enforce what should be enforced by structure.
Competitors constrain structurally and need almost no prompt: Thesys C1 emits a
small DSL over ~80 closed, purpose-built components; Tambo (fully MIT, backend
and prompts included) makes each UI component a *tool call* whose JSON schema
is the contract — their whole system prompt is ~1,500 tokens. Vendo is the only
one of the four that can construct genuinely novel, host-branded UI. That
capability is our differentiator AND the source of this failure class.

## Goals

1. Cut the create contract to what a human can read, without losing constraint.
2. Make the escape hatch **earned, not default** — while keeping the capability.
3. Give every pipeline stage one job.
4. Eliminate capability substitution with mutating tools.
5. Improve or hold: failure rate, p50/p90 latency, repair rounds.

## Non-goals

- Closing the source or moving generation server-side (decision reaffirmed
  2026-07-27: two of three competitors are fully OSS; our moat is the private
  improvement loop and the host runtime, not prompt text).
- Removing islands. Construction is the differentiator.
- Changing the persisted format tag or breaking documents at rest.

## Design

### D1 — Widen before narrowing (sequencing law)

The measured regression proves the order. **The component vocabulary grows
first**; the escape hatch narrows only after there is somewhere better to go.
Any lane that narrows before widening is rejected on principle.

Vocabulary direction: from primitives toward **answer-shapes** — the composite
blocks C1 ships (overview block, snippet/entity list, metric row, section
block, follow-up block) rather than more atoms. Selection criterion is the
measurement: every island observed in the baseline is triaged into "an
answer-shape would have covered this" vs "genuinely custom", and the former
set defines the vocabulary backlog.

**House rule applies:** new components are UI-bearing, so this workstream needs
designed, clickable mockups before implementation sign-off — not wireframes.

### D2 — Decompose the pipeline into single-purpose passes

Today one model call carries eight concerns (structure, component choice,
binding syntax, budgets, custom-code decision, code authoring, action wiring,
capability honesty) behind six recovery mechanisms. Target: each pass has one
job, its own contract, and its own validator. Tree composition and island
authoring become **separate passes** — an island pass runs only when the tree
pass explicitly requests one, so island vocabulary never pollutes the main
call and the escape hatch stops sitting next to the front door.

### D3 — The prompt carries only what validators cannot

Every rule in the contract is triaged: **enforced by a validator → delete from
the prompt** (repair teaches it in context, with the violation); **not enforced
but load-bearing → either enforce it or express it as a worked exemplar**;
**neither → delete**. This principle is already written in `exemplar.ts` and
was never applied to production. Target: contract size cut by ≥50% with no
regression in failure rate.

### D4 — Resolve the pipeline combinatorics

Five independent flags (paint, region-parallel, exemplar contract, structured
repair, end pass) = 32 possible pipelines, with an A/B unresolved long enough
that nobody knows the better arm. Measure the arms that matter, pick ONE
production pipeline, delete the losers. Flags that survive must have a stated
reason to be configurable.

### D5 — Capability-substitution gate

A mutating tool may only be invoked for a purpose consistent with its
description. When the host lacks a capability the ask needs, the honest
Disclaimer path is mandatory. This is enforcement, not prose — and it is the
one narrowing permitted before D1 lands, because the failure mode is a safety
issue, not a quality issue.

## Success criteria (measured, not argued)

Baseline exists at `apps/genui-bench/measurements/2026-07-27-island-escape-baseline.json`.

| metric | baseline | target |
| --- | --- | --- |
| failure rate | 7% | ≤ 7% (hard gate — never worse) |
| apps with island ratio > 0.6 | 30% | < 10% |
| island reaches mutating tool | 9% | 0% |
| contract static tokens | ~8,300 | ≤ 4,000 |
| duration p50 / p90 | 16.1s / 103.3s | ≤ baseline |

**Anti-overfitting law** (the v2 lesson: 6/6 dev vs 11/30 held-out): counter-
example tests are mandatory per gate; no tuning to named prompts; a held-out
prompt set is generated fresh at evaluation time and never used during
development.

## Risks

- **Documents at rest.** External customers hold current-format apps (Luminovo
  14, Keywork 12, plus unreachable BYO installs). Any format change must keep
  them renderable; the persisted tag is frozen.
- **Latency.** Decomposition adds model calls. Mitigated by passes being
  smaller and by islands becoming rare; must be proven, not assumed.
- **Scope.** This is four workstreams. Sequenced, each independently landable.

## Decisions (Yousef, 2026-07-27)

1. **Vocabulary ambition: SIGNED — the conservative ~10 composites**, chosen by
   triaging the measured island cases, not by copying C1's catalogue. Breadth
   can follow once the first ten prove out.
3. **Sequencing: SIGNED — D5 (capability-substitution gate) ships NOW**, on its
   own PR, ahead of the wave. It is a safety fix, not a quality tradeoff.

### Still open (non-blocking)

2. **Island policy end-state** — should islands eventually require explicit host
   opt-in (a capability the host enables), or stay always-available but
   structurally discouraged? Deferred until the composites land and we can see
   how much island demand actually remains.
