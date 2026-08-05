# Generation pipeline v2

**2026-07-28.** Designed with Yousef; awaiting his sign-off. Nothing builds
before that. Replaces the pipeline half of the 2026-07-27 spec; the composite
vocabulary work (D1) continues unchanged.

## The idea

One smart model — **the brain** — owns each app, in one ongoing conversation.
It reads every request and either builds it on the spot (tiny), writes a short
plan (normal), or says "your host can't do that" honestly (impossible). Plans
are filled in by fast parallel workers. An AI reviewer judges the result.
Anything wrong gets fixed by editing the app like a text file. That's the
whole pipeline.

Three principles behind every detail:

1. Models read and write plain text, like a file. Ids, hashes, bookkeeping
   are the machine's problem and never appear in a prompt.
2. Whoever did the thinking finishes the job or writes the spec — thinking is
   never handed over a wall, and never done twice.
3. UI binds to data when the data is real — host data at plan time, sandbox
   data when the sandbox finishes. Nothing is built against a guess.

## Creating an app

- **Brain** (big model, thinks once): tiny ask → writes the app directly,
  done in one call. Normal ask → writes a plan: tabs/pages → groups →
  components, plus which host data each part shows, plus — only if needed —
  custom component (island), automation, or server work.
- **Skeleton**: the plan renders immediately as the real layout with
  placeholders (~4s). No throwaway preview.
- **Workers** (fast model, no thinking): one per group, in parallel, each
  seeing only its group, its components' docs, and real sample rows from the
  queries (which start running at plan time). Groups are the coherence unit —
  things that must tell one story are written by one worker.
- **Islands and server work** happen only when the plan asked. Workers
  can't produce them — the vocabulary isn't in their prompt.
- Structure is three levels, no deeper: containers (tabs/pages) → groups →
  components. Arrangement inside a group is attributes, not nesting.
- Concurrency is a number we tune, not a mode. There is one pipeline.

## Editing an app

Same brain, same conversation — it remembers the plan and every turn, so
"no, the other chart" works. Small ask → find/replace edits on the app text,
applied and validated. Structural ask → it plans the new part and workers
fill it. Machine repairs use the same mechanism with the finding as the
instruction: fix-it edits (×2), then re-plan as the last resort. The plan is
scaffolding; after creation the app text is the only truth.

## Checking

A plug-in layer: app + request in, findings out.

- **Facts = code, instant:** does it parse; do the named tools, components,
  schedules, fields exist; do types fit.
- **Judgment = the AI reviewer, one pass per finished app:** invented data,
  dishonest tool use (a payment tool is not a message channel), buttons that
  do nothing, sections that don't answer the ask.
- **Hosts can plug in their own checks** — their compliance rules, their
  model or their code.

The old deterministic judgment gates (law-1 literals, D5) stay in place until
the reviewer passes a replay of the recorded incidents and apps; evals run
later, Yousef's timing.

Prompts stay short and human-readable: each actor gets one page about its
job plus a handful of one-sentence rules. A new rule is added only when a
mistake demonstrably recurs. The component menu scales by search — the core
set is inline, the growing long tail (host + user components) is queried by
the brain while planning.

## Computed values

The model never does math itself — it writes an expression like
`sum(invoices.data, "amount_cents")` and the runtime computes it fresh on every
render, so numbers never freeze stale. The reviewer judges whether the
expression makes sense.

## The sandbox

- **Layer 2 (backend):** the plan declares intent only — never a guessed
  interface. Independent sections build immediately; the sandbox agent builds
  freely, reports its real interface with samples, and dependent sections
  fill afterwards, against truth. The old graduate/rebind ceremony is gone.
- **Layer 3 (whole app served):** unchanged — last resort for interaction
  models components can't express, same flags, edits become instructions to
  the sandbox agent through the same brain session.
- Automations unchanged: trigger on the app, grants as approval, results
  collection as the logbook shown in the app. A generated automation always
  has an app as its home.

## What dies

The regex judge, the paint lane, region-parallel, the 7 flags, all four
repair subsystems, the edit-ops grammar, visible ids (identity is derived
from the edit spans; diffs are git-style text diffs), the 8,300-token
contract, the empty-document rule, the graduate() ceremony.

## What stays

The stored format (every existing app keeps rendering), automations + grants
+ results collections, the island sandbox and its test drive, pins / drift /
rebase, history and undo, the adapter and BYO rules.

## Settle by measurement, later

Fill concurrency · queries-during-build on/off · fill model tier · the
reviewer exam (gates the deletion of the old checks) · how many recorded
islands the computed-values menu absorbs.

Hard gates: failure rate never worse than today's 7%; latency never worse
than today; real layout on screen ≤5s typical.
