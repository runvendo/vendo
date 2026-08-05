# GOLDEN — the frozen Vendo generation eval

Status: FROZEN 2026-07-19 (Wave 0). This is the golden set. It is the single
measure of generation quality across waves. Source of the 30 held-out prompts:
`docs/verification/vendo-v2-heldout/CORPUS.md` (authored blind after the
6/6-equivalent dev milestone). Baseline at freeze: **11/30** browser-judged
error-free (2026-07-19).

## Rules — read before running

1. **FROZEN. Never tuned against.** No prompt here is ever used to guide a code
   change, prompt edit, or schema tweak. Tuning against the golden set destroys
   its only value (it measures generalization, not the dev set). Fails are the
   data.
2. **Run ONCE per wave.** One full pass on the 30, recorded with timing and a
   verdict per prompt. Not on every PR — per wave.
3. **Browser-judged with screenshots.** Each prompt is driven through the real
   Apps create path in a real browser; the verdict is a human reading the
   rendered app against the PASS bar, with a screenshot as evidence. Tests and
   typecheck do not count.
4. **A discussed prompt is burned.** Any golden prompt named, quoted, or
   analyzed in a fix PR (or used to reproduce a bug) is contaminated: move it to
   the DEV list below and replace it in the golden set from the fresh pool
   before the next run. The golden set only counts prompts no fix has ever seen.
5. **Metric = browser-judged error-free rate** over the 30. `[impossible]`
   prompts count as PASS only when handled honestly (empty-state/disclaimer); a
   fabricated app is a FAIL.

## PASS bar (judge each prompt honestly)

A prompt PASSES when the rendered app is:

- a real app of host/prewired components with real data — or an HONEST
  empty-state / disclaimer when the host lacks the tool for the ask;
- a working chart where a chart was asked;
- Selects populated with real `{value, label}` options;
- money and dates formatted (no raw cents, no raw ISO strings);
- free of raw-brace or object cells;
- actions that carry payloads and fire (approval-gated counts as PASS) — or an
  honest disclaimer when no tool can do it;
- free of any error box or error blob.

`[impossible]` prompts PASS only via honest handling — a fabricated app is a
FAIL. Record timing (submit → app visible) for every prompt.

Category tags per prompt: `[chart] [table] [select] [action] [format] [vague]
[impossible→honesty]`.

## The 30 golden prompts

### demo-bank (Maple) — M1–M15

- M1. "show me my account balances at a glance" [vague]
- M2. "a dashboard of my monthly cash flow with income vs spending" [chart][format]
- M3. "list my upcoming scheduled payments and let me cancel one" [table][action]
- M4. "a card spending tracker grouped by merchant" [table][format]
- M5. "help me find any duplicate or suspicious charges" [table][vague]
- M6. "a savings goal tracker for a $10,000 vacation fund" [chart][format]
- M7. "compare my spending this month vs last month" [chart][format]
- M8. "a quick-transfer widget for moving money to savings" [select][action][format]
- M9. "show my largest 10 transactions this year with details" [table][format]
- M10. "a budget view: how much I have left to spend this month per category" [table][chart][format]
- M11. "an app to pay my credit card bill" [action][select][format]
- M12. "a currency converter for my balances" [impossible→honesty (no FX tool)]
- M13. "show my crypto portfolio" [impossible→honesty (no crypto tools)]
- M14. "a net worth trend chart with account breakdown" [chart][table][format]
- M15. "a form to add a new payee and send them $50" [action][impossible-or-multi-step→honesty]

### demo-accounting (Cadence) — C1–C15

- C1. "a client health dashboard: who's behind on documents" [table][chart][vague]
- C2. "show all clients with their assigned staff and deadlines" [table][format] (object cells!)
- C3. "a document collection progress board grouped by status" [table][format]
- C4. "an app to message a client about their missing documents" [select][action]
- C5. "a workload view: how many clients per staff member" [chart][table]
- C6. "show filing deadlines on a timeline for the next 90 days" [chart][format]
- C7. "a client onboarding checklist app" [vague][action-honesty]
- C8. "help me prioritize which clients to chase this week" [table][vague]
- C9. "a payroll summary dashboard" [impossible→honesty (no payroll tools)]
- C10. "an invoice aging report with totals by bucket" [impossible→honesty (no invoice tools)]
- C11. "show me each client's contact info as cards with a quick message button" [action][format]
- C12. "a season progress tracker: percent of documents collected firm-wide" [chart][format]
- C13. "a form to update a client's filing deadline" [action-or-honesty (check host tools)]
- C14. "compare document completion rates across staff members" [chart][table]
- C15. "an end-of-week status report I can send to the team" [vague][action-honesty]

## DEV list — burned prompts (tune freely, never counted)

These six drove the pre-freeze dev milestone (`docs/verification/vendo-v2-generalize/`,
PRs #385–#397). They are contaminated by construction — use them for iteration,
never as a quality number.

- D1. demo-bank: "spending breakdown by category this month with a chart"
- D2. demo-bank: "a filterable list of recent transactions"
- D3. demo-bank: "a form to transfer money between two accounts"
- D4. demo-accounting: "overdue invoices with a reminder button"
- D5. demo-accounting: "a revenue vs expenses summary with a chart"
- D6. demo-accounting: "a new-client intake form"

Any golden prompt discussed in a fix PR joins this list (rule 4).

## Tranche 2 — the F-set (frozen 2026-07-20 after its single fresh run)

Authored blind pre-gate (`docs/superpowers/plans/2026-07-20-final-gate-fresh10.md` on the
format-gen-v2 branch), run ONCE in the 2026-07-20 final gate as the fresh pool.
**Baseline: 8/10** (F3, F5 FAIL). Now frozen under the same rules as the 30; each future
wave authors a NEW fresh pool (fresh sets, once run, become frozen tranches).

- F1. demo-bank: "I'm trying to figure out if I can afford a $3,000 vacation in October — help me"
- F2. demo-bank: "a bill-pay center: upcoming bills, what I paid last month, and pay one now"
- F3. demo-bank: "which subscriptions should I cancel? rank them and let me act on it"
- F4. demo-bank: "show my student loan balance and payoff plan" [impossible — no loan tools]
- F5. demo-bank: "a weekly money digest I could glance at every Monday morning"
- F6. demo-accounting: "which clients are most at risk of missing their filing deadline, and message the top one"
- F7. demo-accounting: "a staff performance review packet for our next team meeting"
- F8. demo-accounting: "track our firm's revenue per client this quarter" [impossible — no revenue/billing tools]
- F9. demo-accounting: "a client detail page for Blue Bottle Coffee: everything we know, with quick actions"
- F10. demo-accounting: "help me plan next week: what's due, who's assigned, what needs chasing"

## Tranche 4 — the H-set (FROZEN 2026-07-25 after its single rematch run)

Authored blind before the 2026-07-25 rematch gate (first commit of the gate branch,
before any host was booted and before any generation output was seen), in the spirit
and difficulty of the frozen 30: natural user asks with an archetype spread
(dashboard / worklist / detail page / form-flow / board-timeline / report), two
`[impossible]` and two partially-feasible per host. T4 is the gate set for all three
rematch arms; the frozen 30 is NOT re-run (exhausted for cross-config comparison —
it has now been the scored set for three configs across three waves, and its fails
are individually analyzed in merged PRs' gate evidence, so a fresh blind tranche is
the only uncontaminated cross-arm measure). Run ONCE in the 2026-07-25 rematch gate
(`docs/eval/runs/2026-07-25-rematch/`). **Baseline: A (production defaults) 2/30 ·
B (endPass) 5/30 · C (exemplarContract+endPass) 2/30** — dominated by a refusal wall
(65/90 attempts produced no app: the island smoke-crash environment bug on Turbopack
production servers, host-components-in-island, and law-1 rejecting user-supplied and
unit-conversion constants; see the run READMEs). Now frozen under the same rules as
the 30; the next wave authors a NEW fresh pool.

### demo-bank (Maple) — H1–H15

- H1. "how am I doing financially this month? one screen" [vague][chart][format]
- H2. "everything I've spent on food and coffee this month" [table][format]
- H3. "what recurring charges am I signed up for, and what do they add up to per month?" [table][format]
- H4. "pay my August rent right now" [action][select][format]
- H5. "a detail page for my credit card: balance, recent charges, and where I use it most" [chart][table][format]
- H6. "are my savings goals on track? show progress for each one" [chart][format]
- H7. "what's leaving my account over the next two weeks?" [table][format][vague]
- H8. "order me lunch from somewhere I've ordered before" [action][vague]
- H9. "I think I lost my card — freeze it and check for anything suspicious" [action][table] (partially feasible — no card-freeze tool; the suspicious-charge review is feasible)
- H10. "what's my credit score and what's driving it?" [impossible→honesty (no credit-score tools)]
- H11. "show my credit card rewards points and how to redeem them" [impossible→honesty (no rewards tools)]
- H12. "set a $200 monthly entertainment budget and track how I'm doing against it" [chart][format] (partially feasible — budgets are read-only: tracking exists, creating does not)
- H13. "a month-end summary I can hand to my accountant" [vague][format]
- H14. "I need $2,000 tomorrow — which account should it come from? compare my options" [table][format][vague]
- H15. "a timeline of my paychecks this year: when they landed and how much" [chart][format]

### demo-accounting (Cadence) — H16–H30

- H16. "how's tax season going? one screen for the partners" [vague][chart][format]
- H17. "which clients have a filing deadline in the next 30 days and are still missing documents?" [table][format]
- H18. "go through Sweetgreen's uploaded documents and verify or reject each one" [action][table]
- H19. "a client page for Compass: where they stand, their documents, and our conversation" [table][format]
- H20. "what should Tomas Okafor work on today? his clients, their gaps, what to chase" [table][vague]
- H21. "which clients have gone quiet on us? show who hasn't responded and nudge one" [table][action]
- H22. "every document we're still waiting on, grouped by client" [table][format]
- H23. "a recap of this week's activity for the partners' meeting" [vague][format]
- H24. "push Blue Bottle Coffee's filing deadline out two weeks and let them know" [action] (partially feasible — no deadline-update tool; the message half is feasible)
- H25. "reassign Priya Natarajan's clients to Tomas while she's on vacation" [action][table] (partially feasible — no reassignment tool; listing her clients is feasible)
- H26. "book each client's review call for when their documents are done" [impossible→honesty (no calendar/scheduling tools)]
- H27. "show the status of our e-filed returns with the IRS" [impossible→honesty (no e-file tools)]
- H28. "a leaderboard: which staff member gets documents back fastest?" [chart][table]
- H29. "what changed today? everything that happened while I was out" [table][vague][format]
- H30. "a chase list for Friday: who to message, about what, in what order — and send the first one" [table][action][vague]

## Run ledger

| Date | Set | Score | Main @ | Evidence |
|---|---|---|---|---|
| 2026-07-19 | frozen 30 (baseline) | 11/30 | pre-v3 | branches `vendo-heldout-maple`/`-cadence` |
| 2026-07-20 | frozen 30 | **18/30** | 090b1779 (full v3) | `docs/verification/final-gate/` (PR #436) |
| 2026-07-20 | F-set (fresh) | **8/10** | 090b1779 | `docs/verification/final-gate/` (PR #436) |
| 2026-07-25 | H-set (fresh → frozen as Tranche 4), arm A = production defaults | **2/30** | afa66bec | `docs/eval/runs/2026-07-25-rematch/` |
| 2026-07-25 | H-set, arm B = endPass (data-sighted verify) | **5/30** | afa66bec | `docs/eval/runs/2026-07-25-rematch/` |
| 2026-07-25 | H-set, arm C = exemplarContract+endPass | **2/30** | afa66bec | `docs/eval/runs/2026-07-25-rematch/` |
| 2026-07-25 | design pairwise on shipped pairs (opus-4-8, both orderings) | **B-vs-A 6W/1L/1T (8 pairs) · C-vs-A 0W/1L/3T (4 pairs)** | afa66bec | `docs/eval/runs/2026-07-25-rematch/design-pairwise.md` |
| — | NOTE: the frozen 30 was NOT re-run this wave (exhausted for cross-config comparison after three scored configs; T4 is the cross-arm measure) | | | |
