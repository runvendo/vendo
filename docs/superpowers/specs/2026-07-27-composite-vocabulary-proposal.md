# Composite answer-shape vocabulary — D1 triage and proposal

**Date:** 2026-07-27 · **Status:** awaiting Yousef's sign-off
**Input to:** decision 1 of `2026-07-27-generation-pipeline-redesign-design.md`
("vocabulary ambition: SIGNED — the conservative ~10 composites, chosen by
triaging the measured island cases, not by copying C1's catalogue")
**Designed mockups:** [`assets/2026-07-27-composite-vocabulary-mockups.html`](./assets/2026-07-27-composite-vocabulary-mockups.html)
— every proposed composite in both hosts' real brand styling, with empty
states, interactive, openable as a local file.

## Headline

**The evidence supports eight composites, not ten.** Two further shapes that
would round the number out are blocked on a *derivation* facility, not on
vocabulary — proposing them as components would be padding. That finding is
itself an input to the wave plan, so it is stated here rather than hidden.

The triage also produced a second, unavoidable result: **six missing props on
existing Kit components are prerequisites, not nice-to-haves.** One of them —
form fields being unable to name the tool argument they fill — is the direct
mechanical cause of the largest island cluster. No composite in tier 1 can be
built before it lands.

## Evidence base

Wider than the baseline file alone. Every run record on disk with an island was
read in full, not sampled.

| | |
| --- | --- |
| island-bearing apps read | 52 |
| islands read (2 apps carry two each) | 54 |
| distinct asks represented | 19 |
| measurement arms | `baseline`, `after`, `rulea`, plus ad-hoc `runs/` |
| hosts | Maple (demo-bank) and Cadence (demo-accounting) |

Sources: `apps/genui-bench/measurements/2026-07-27-island-escape-{baseline,after}.json`
for the distribution, and `vendo.wire.txt` + `run.json` under
`apps/genui-bench/runs/` and `apps/genui-bench/runs/_measure/{baseline,after,rulea}/`
for the island source and the originating prompt.

### Method, and one correction to how "cause" is read

Each island was classified by **the one thing the tree could not express** — the
*cause* of the escape. Everything else inside an island is collateral: once the
model is authoring TSX it hand-rolls tables, stat tiles and badges even where
Kit atoms already exist, because it is no longer in the tree's frame of
reference. Counting collateral as evidence would have inflated the vocabulary
with sugar (a "MetricRow" that `Row` + `Stat` already delivers). Collateral is
counted separately, and only as evidence for the *prop* gaps in tier 2.

## Triage — the counts

| category | islands | share |
| --- | --- | --- |
| **(a) an answer-shape would have covered this, entirely** | 35 | 65% |
| **(a-partial) a shape covers the data or verdict half; a small genuinely-custom core remains** | 7 | 13% |
| **(b) a Kit gap — an existing component almost worked** | 1 | 2% |
| **(c) genuinely custom — should stay an island** | 9 | 17% |
| **(d) spurious — the tree already had the vocabulary and the model didn't reach for it** | 2 | 4% |

Read plainly: **four out of five islands existed because the vocabulary was too
primitive to say the answer**, and only one in six was the differentiator doing
its job. Category (d) is small but diagnostic — one island existed solely to
wrap a `Disclaimer` the tree could have emitted directly, and one existed to add
a search box that `DataTable searchable` already provides. Those two are D2/D3
problems (pass decomposition and prompt triage), not vocabulary problems.

## Triage — by ask

Every measured ask, the islands it produced, and the shape it was reaching for.

| ask | host(s) | islands | mean ratio | wanted shape | verdict |
| --- | --- | --- | --- | --- | --- |
| let me transfer money between my accounts | both | 7 | 0.74 | ActionForm | (a) ×6, (d) ×1 |
| list my saved payees and let me pay one | maple | 2 | 0.92 | ActionForm | (a) |
| let me chase every overdue invoice in one go | cadence | 3 | 0.56 | ActionList | (a) |
| which clients still owe me documents, let me nudge them | cadence | 2 | 0.73 | ActionList | (a) |
| a button to approve all requests, popup with the list | maple | 1 | 0.93 | ActionList | (a) |
| show my cards and let me freeze or unfreeze each one | maple | 1 | 0.92 | ActionList | (a) |
| saved payees, each row a Send $25 button | maple | 1 | 0.94 | ActionList | (a) |
| let me set a budget per category and show how close I am | both | 5 | 0.88 | MeterList | (a) |
| spending by category with budgets | maple | 1 | 0.46 | MeterList | (a) |
| build me a savings goal tracker: pick a target, show progress | both | 4 | 0.90 | MeterList + a projection | (a) ×1, (a-partial) ×3 |
| let me edit the category on any transaction inline, keep a running total | both | 4 | 0.92 | EditableTable | (a) |
| every account, under each its transactions by month with a running balance | both | 4 | 0.92 | GroupedList | (a) |
| show revenue by client with a chart, let me drill into one | both | 2 | 0.80 | DrilldownList | (a) |
| show anything unusual in my spending | maple | 2 | 0.52 | AnswerBlock | (a) |
| one screen that answers: can I afford to hire someone | both | 4 | 0.70 | AnswerBlock + arithmetic | (a-partial) |
| which subscriptions went up in price this year, and by how much | maple | 1 | 0.81 | derived rows (render was already a `DataTable`) | (b) |
| let me split last week's grocery charge, then send requests | both | 3 | 0.93 | — | (c) |
| create a component with a big Y | both | 6 | 0.88 | — | (c) |
| show my recent transactions with search | cadence | 1 | 0.88 | `DataTable searchable` already exists | (d) |

Ratio is measured per app (island source ÷ wire characters), so the two apps
carrying two islands each contribute one ratio, not two.

Two rows deserve calling out.

**"which subscriptions went up in price" is the only pure Kit-gap case, and it
is not a UI gap.** The island's *rendering* was already a Kit `DataTable`. The
island existed because answering the question needs two time-windowed queries,
a per-merchant median, and a delta — a derivation. No component retires it.

**"can I afford to hire someone" is the proof that widening works.** In the
baseline arm it produced a 0.99-ratio, zero-query, 11,301-character island that
was the entire screen. In the `after` arm, against a richer tree (39 nodes, six
queries), the same ask produced a 0.54-ratio island containing *only* the
calculator. Give the tree more vocabulary and the island shrinks to its
genuinely-custom core, exactly as D1 predicts.

## The ranked eight

Ranked by frequency × how badly the island rendered, with the safety weight the
design doc already applies: five of the six measured mutating-tool escapes sit
in clusters 1 and 2.

For each: what it does, what it retires, what it binds to, its state behaviour,
and — the constraint that decides whether any of this works — **how the model
knows to reach for it.**

---

### 1 · ActionForm — 8 islands, mean ratio 0.78

**Job.** Collects the arguments one host tool needs, confirms before it fires,
and owns the whole result lifecycle.

**Retires.** All six `TransferForm` islands, `PayPayeeForm`, `PayeePayIsland`.
Carries three of six measured mutating-tool escapes.

**Binds to.** One host tool, named. Each field declares which of that tool's
arguments it fills; option-bearing fields bind to a query result for their
choices (accounts, payees, clients). The composite reads the tool's own schema
for which arguments are required, so a form that cannot be completed is a
detectable error rather than a runtime surprise.

**States.** *Empty* — when no host tool matches the ask, it renders the honest
Disclaimer refusal instead of inputs it cannot submit; it never draws a dead
form. *Loading* — option lists resolve before the field is interactive.
*Confirm* — a mandatory review of the exact values, for any tool the guard
classes as mutating. *Submitting* — the primary action is the only thing that
changes; inputs stay legible. *Awaiting approval* — a first-class state, because
the guard holding a real call is neither success nor failure. *Success* and
*Failed* — failure keeps every input, names what the host rejected, and offers
retry.

**Why the model reaches for it.** Any ask containing a verb it must perform —
transfer, pay, send, request, cancel, freeze. This is the most obvious mapping
in the set: one action on one thing.

---

### 2 · ActionList — 8 islands, mean ratio 0.74

**Job.** Rows of real records where each row, or a selected set of them, can be
acted on by one host tool, with the outcome reported per row.

**Retires.** `ChaseAll`, `ChaseMessageIsland`, `ChaseMessagePanel`, `NudgePanel`,
`NudgeForm`, `ApproveForwardModal`, `CardFreezeManager`, `PayeeQuickSend`.

**Why it ranks second despite tying on count.** This cluster contains the
capability-substitution defect named in the design doc: `ApproveForwardModal`
(0.93 ratio, 12,353 characters) repurposed `host_transferMoney` as a Slack
channel, sending one cent to a "Slack Forwarding Bot" with the approved
transactions encoded in the memo. It also contains the clearest *wrong answer*
in the corpus — asked to chase every overdue client "in one go", all three
attempts built a one-client-at-a-time form.

**Binds to.** A query result for the rows, plus one host tool. Two modes:
per-row (each row's own action) and bulk (an explicit selection, one primary
action over it). The tool's arguments are filled from the row, so the binding is
per-row rather than per-form.

**States.** *Empty* — carries the meaning of empty ("nothing to chase", "all
caught up"), and hides the action rather than disabling it. *Per-row pending /
done / failed* — never one opaque aggregate. *Partial* — the summary states "3
sent · 1 sending · 1 failed" and lets the failed row be re-run alone. *No
selection* in bulk mode disables the primary action with the reason visible.

**Why the model reaches for it.** Plural + verb: "chase every…", "nudge them",
"approve all", "freeze each one". The plural is the signal.

---

### 3 · MeterList — 7 islands, mean ratio 0.80

**Job.** One labelled progress row per category or goal: actual against target,
the remainder, the overrun, and an editable target.

**Retires.** `CategoryBudgetTracker` ×2, `CategoryBudgets`, `BudgetManager`,
`BudgetTracker`, `BudgetProgressPanel`, `GoalProgressBars`. Four distinct asks
converge on this one shape — the widest convergence in the corpus.

**Binds to.** A query result supplying the label and the actual value, and a
target that is either a second query result, a host tool for reading and
writing, or declared session-local.

**States.** *Empty* — no categories yet, with the reason. *No target on a row* —
the row still renders its actual figure with an empty meter and a set-target
affordance; it does not vanish. *Over target* — its own tone and an explicit
overrun figure, not a clipped bar. *Editing* — inline, keyboard-committable.
*Target not persistable* — when the host has no write tool, the composite says
so once, at the bottom, in the honest-Disclaimer voice.

That last state is load-bearing. Every measured budget island hit exactly this
situation and three of them **faked persistence** — one waited 400ms on a timer
and showed "Saved ✓", one called a *read* tool and showed "✓ Saved". Owning the
state in the composite is what stops the model inventing it.

**Why the model reaches for it.** "How close am I to…", "set a budget/target/
limit per…", "progress toward…". Any ask pairing a measured value with a target.

---

### 4 · GroupedList — 4 islands, mean ratio 0.92 (joint highest)

**Job.** Rows nested under the thing they belong to, one or two levels deep,
each group carrying its own subtotal and count, expandable.

**Retires.** `AccountsMonthlyView`, `AccountMonthlyView`, `AccountMonthly`,
`MonthlyActivityByAccount` — including **the worst-composed case in the
corpus**: 12,120 characters of island at a 0.99 ratio, **zero queries**, a
hand-rolled HTML `<table>` with inline styles reproducing what `DataTable`
already does, against Thesys C1's clean answer to the same prompt in 12.8s.

**Binds to.** One query result plus the field to group by, and optionally a
second nesting level. Each group's subtotal and count are declared over the
grouped rows. Running totals are a column behaviour (see tier 2), not island
arithmetic.

**States.** *Empty* — no groups at all, with the reason. *Group present but
empty* — the header and its figure still render, because the account is real and
its balance is real; only the rows are missing. *Collapsed* is the default past
a threshold, so a 47-transaction account does not open as a wall.

**Implementation note.** This is best built as a named mode over `DataTable`
rather than a new rendering primitive — see "One design call for you" below.

**Why the model reaches for it.** "…and under each one its…", "grouped by",
"by month", "per client". Explicit nesting language in the ask.

---

### 5 · EditableTable — 4 islands, mean ratio 0.92 (joint highest)

**Job.** A table where one column is editable in place, each edit routed through
a host tool, and each row showing its own saving / saved / failed state.

**Retires.** All four `CategoryEditor` islands. One ask, both hosts, four
attempts, four independently hand-rolled tables — the most reproducible escape
in the corpus.

**Binds to.** A query result for the rows, one editable column, its allowed
values (a literal set or a query result), and the host tool the edit calls. An
optional derived totals companion over the same rows, so an edit and its
consequence live in one component.

**States.** *Empty* — no rows to edit, with a widen-the-range affordance.
*Per-row saving / saved / failed* — failure reverts the displayed value to the
truth and names what the host rejected. *Read-only rows* — a row the host will
not accept an edit for renders its value without a control, rather than offering
an edit that will fail. *No write tool at all* — degrades to a plain
`DataTable` with the honest note, instead of a control that pretends.

**Why the model reaches for it.** "let me edit … inline", "change the … on any
…", "reclassify", "fix the category".

---

### 6 · AnswerBlock — 2 islands primary, 6 more partially

**Job.** States the answer to a question in one line, then shows the named
checks that produced it — each passing, failing, or honestly unanswerable.

**Retires.** `BudgetOverrunCallout` and `UnusualChargesPanel` outright, plus the
*output half* of all four `Hire…Calculator` islands and the two savings-goal
projections. Its primary evidence is the thinnest of the eight and is stated as
such; its claim rests on the six partial cases, which are the highest-value asks
in the corpus ("one screen that answers…").

**Binds to.** A verdict and its one-line reason, and a list of named checks,
each with an outcome and the figure that produced it. Every figure must trace to
a tool result; a check with no citable number is the invented-data failure the
format already forbids.

**States.** *Empty* — an explicit "no answer" with the reason. This is the one
shape where a blank card would be a lie, so blank is not a permitted rendering.
*Not-checked* — a third outcome beside pass and fail, for a check the host
cannot support. In the mockup Maple cannot detect duplicate charges because it
exposes no merchant-reference field; the check is shown as *not checked* rather
than quietly dropped. *Partial* — a verdict qualified by how many checks ran.

**Why the model reaches for it.** Interrogative asks: "can I…", "am I…", "are
we…", "which of my… and by how much", "show anything unusual". Any ask whose
honest answer is a sentence before it is a table.

---

### 7 · DrilldownList — 2 islands, mean ratio 0.80

**Job.** A ranked list with each row's share of the whole, where picking a row
opens its detail beneath without leaving the app.

**Retires.** `ClientDrilldown`, `ClientDrilldownPanel`. Selection-plus-detail was
additionally hand-rolled inside three other islands as collateral.

**Binds to.** A query result ranked by one value field, with each row's share
computed against the total, and a detail region bound to the selected row —
either fields already on the row or a query parameterised by its id.

**States.** *Empty* — no rows to rank. **Rows but nothing selected** — a distinct
state, and the one every hand-rolled island got wrong: they rendered a blank
void where the detail would go. The composite renders a "pick one" prompt.
*Detail loading* — the list stays interactive. *Detail failed* — the row stays
selected and the error sits in the detail region only.

**Why the model reaches for it.** "drill into one", "…and let me open one",
"top … by …", "which … are furthest behind".

---

### 8 · EntityCard — 0 islands escaped for this alone

**Job.** One record shown in depth: its name, its state, the handful of facts
that matter, and the actions available on it.

**Evidence class — stated honestly.** No measured island escaped *because* this
was missing. It earns its place on two other grounds. First, it is the single
most hand-rolled block in the corpus, appearing as collateral in twelve-plus
islands — every group header, every drill-down detail panel, every entity row.
Second, and decisively, **GroupedList and DrilldownList both need it**: it is
their group header and their detail region. Building those two without it means
building it twice, unnamed.

**Binds to.** One record — from a query returning a single object, or a
parameterised query. An identity block, a state, a small set of labelled facts,
an optional progress measure, and its actions.

**States.** *Not found* — names what was searched for and offers the search.
*Partial* — the common case, not the exception: the identity block still renders,
missing facts read as an em dash, and an empty region explains itself and offers
the fix. *No actions available* — the action row is absent, not a row of
disabled buttons.

**Why the model reaches for it.** "tell me about…", "show me client X", "give me
a summary of…". Singular, named subject.

---

## Tier 2 — Kit gaps the composites stand on

Not answer-shapes. Missing props on existing components, evidenced by
hand-rolling counts across the corpus. **The first is a prerequisite for tier 1
item 1**; the rest are prerequisites for the states the composites promise.

| gap | component | evidence |
| --- | --- | --- |
| a field cannot name the tool argument it fills | `Input`, `Select`, `DatePicker`, `Textarea` | root cause of all 16 action islands |
| a button has no pending / done / failed / awaiting-approval state | `Button` | hand-rolled 16×, faked 3× |
| a meter has no over-target tone or threshold | `Progress` | hand-rolled 7× |
| a table has no subtotal or running-total column | `DataTable` | hand-rolled 4× |
| no segmented single-choice control | `Select` (a variant) | hand-rolled 3× |
| a card list has no selection or per-card action | `CardList` | hand-rolled 3× |

The first one is worth stating in full because it is the mechanical explanation
for the largest cluster. `Form` names a host tool on submit. `Button` names a
host tool on click. But `Input`, `Select`, `DatePicker` and `Textarea` have no
way to say *which argument they fill*. A tree can therefore render a form it can
never submit. Every "let me do X" ask closed that gap the only way available to
it: in island code, with `tools.host_*` called by hand. This is not the model
misbehaving — it is the model routing around a hole.

## Rejected

Each of these was considered and turned down. C1 ships most of them; our
measurement does not support them.

| rejected | why |
| --- | --- |
| **MetricRow / MetricIndicatorInline** | `Row` + `Stat` already does it, and the `after` arm proves the model composes them correctly at tree level. The hand-rolled stat tiles are collateral inside islands, not a cause of escape. Pure sugar. |
| **Timeline / Steps** | Zero evidence. Not one measured ask wanted a stepped or chronological progression as its shape. C1 shipping it is not evidence for us. |
| **FollowUpBlock** | Zero evidence. No measured island rendered suggested next questions. This is a chat-surface concern, not an app-vocabulary one. |
| **OptionCards / Chips** | One weak signal (a hand-rolled two-way toggle). That is a `Select` variant in tier 2, not a composite. |
| **SnippetCardBlock / VisualCardBlock / CompositeCardBlock** | C1 catalogue shapes with no counterpart in our corpus. Adopting them would be copying, which decision 1 explicitly rejected. |
| **CompareBlock / DeltaTable** | Tempting — "compare this month against the same month last year" and the subscription-price ask both want it. But in both cases the *rendering* was already a `DataTable`; the blocker was computing the comparison. A component does not fix that. See below. |
| **ScenarioInputs / WhatIf calculator** | The largest remaining custom class (7 islands) and the most tempting single addition. Rejected because a component cannot hold arbitrary arithmetic — expressing it would mean shipping a formula language, which is a far larger decision than a vocabulary widening. |
| **A dedicated split / allocation editor** | 3 islands, all from one prompt. Building it would be overfitting to a named prompt, which the anti-overfitting law in the design doc forbids. `ActionList` retires its send half; the allocation half stays an island. |

## Where the evidence was too thin — read this before asking for ten

Three honest gaps in what the measurement can support.

**1. Only eight shapes are earned.** Getting to ten means either adopting C1
shapes we have no evidence for, or promoting tier-2 prop gaps into
components. Both are worse than shipping eight and revisiting once they prove
out — which is what decision 1 already says ("breadth can follow once the first
ten prove out").

**2. The two shapes that would make ten are blocked on derivation, not
vocabulary.** Compare/delta and what-if scenarios together account for 8 of the
54 islands. Both need the format to express a *computed* value — a
multi-window aggregate, or arithmetic over user input. This is a distinct
capability from component vocabulary and deserves its own decision. Recommending
it here without scoping it would be padding.

**3. AnswerBlock's primary evidence is 2 islands.** Its case rests on six
partial cases and on the fact that the asks it serves ("one screen that
answers…") are the highest-intent asks we measure. It is ranked sixth for that
reason. If you want to cut the set from eight to seven, this is the one to cut —
though note it is also the only shape that structurally enforces the
honesty rule the corpus repeatedly broke.

## One design call for you

`GroupedList` and `EditableTable` could ship as **new component names** or as
**new modes on `DataTable`**. The mechanism matters because it decides whether
the model finds them.

The measurement cuts both ways. In favour of props: the model already reaches
for `DataTable`'s advanced props correctly and unprompted — `searchable`,
`filterableBy`, `paginate`, `sortBy` all appear used well in the `after` arm.
Against props: the catalogue the model is shown lists *components*, so a new
name is a stronger attractor than a new prop on an existing one, and grouping
never appeared as an attempted prop — it went straight to raw TSX.

**Recommendation:** ship them as named components that delegate to `DataTable`
internally. That keeps one table implementation (the smallest sufficient
mechanism) while giving each shape the name the ask maps onto. Both are counted
in the eight on that basis.

## Sequencing implication

Tier 2's first gap gates tier 1's first item, and tier 1's items 4 and 7 both
consume item 8. So the build order the evidence implies is: **tier 2 field
binding and button states first**, then `EntityCard`, then the two highest-value
action shapes, then the rest. No narrowing of the escape hatch until at least
clusters 1–5 are in — that is D1's sequencing law and the 7% → 28% failure-rate
regression is what happens if it is broken.

## The island that stays

After all eight land, the corpus says **9 islands are genuinely custom and 7
more keep a small custom core** — a floor of roughly 30% of today's island
volume, and it should stay. Six of the nine are one ask: "create a component
with a big Y", an SVG drawing in the host's own brand tokens. That is the
capability no competitor has, working exactly as intended.

This is also the honest input to the design doc's still-open decision 2. The
residual is small, legitimate, and concentrated in two recognisable classes
(novel visual construction, and arithmetic over user input). Whether islands
stay always-available or become a declared host capability is a call better made
once the eight composites are measured against a fresh held-out prompt set —
generated at evaluation time, per the anti-overfitting law.
