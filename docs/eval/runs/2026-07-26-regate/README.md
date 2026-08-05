# Re-gate — 2026-07-26 (healed mechanisms; three-arm A/B/C on the blind Tranche 5)

The follow-up to the VOIDED 2026-07-25 rematch (PR #577): the same three-arm protocol
re-run on main @ 76dcf6a3, which contains the three mechanism fixes the rematch
surfaced — f91e0645 (smoke-render environment skips), 8fd5141f (law-1 user-number /
unit-conversion exemption), 76dcf6a3 (island host-component substitution repair).
30 blind fresh prompts (Tranche 5, I1–I30, first commit of this branch), 90 creates,
real Apps create path on production `next start` hosts, dedicated headless browser,
one attempt per prompt per arm, zero tuning, arm order randomized per prompt
(committed schedule, mulberry32 seed 20260726).

| piece | file |
|---|---|
| Maple half (rows + summary + findings) | `README-MAPLE.md` |
| Cadence half | `README-CADENCE.md` |
| Design pairwise (B-vs-A, C-vs-A on shipped pairs) | `design-pairwise.md` / `.json` |
| Raw rows | `results-maple.tsv`, `results-cadence.tsv` |
| Per-create pipeline events + refusal reasons | `pipeline-events-*.json`, `server-logs/` |
| Screenshots, aria (incl. per-island frame aria), re-opens, action fires, approvals, host ground truth | `shots/`, `shots-800/` |
| Harness | `driver.mjs`, `run-half.mjs`, `judge-pairwise.mjs`, `gen-schedule.mjs`, `distill-events.mjs`, `prompts.json`, `PROMPTS.md`, `arm-schedule.json` |

## Scores (Tranche 5, frozen at this result)

| arm | config | Maple | Cadence | total | (voided rematch, T4) |
|---|---|---|---|---|---|
| A | rematch production-defaults control (`pipeline: {}`) | 9/15 | 5/15 | **14/30** | 2/30 |
| B | `{ endPass: true }` | 8/15 | 6/15 | **14/30** | 5/30 |
| C | `{ exemplarContract: true, endPass: true }` | 5/15 | 8/15 | **13/30** | 2/30 |

**7/90 attempts produced no app** (1 Maple + 6 Cadence, all server-logged engine
refusals) vs the rematch's 65/90 — the fixes' proof. Zero smoke-render
environment-skip lines: the crash gate is ACTIVE under Turbopack production servers
(it caught a real island crash on Maple and island-repair fixed it in-flight).

## The headlines

1. **The three fixes worked.** Refusals 65/90 → 7/90. Law-1 no longer rejects the
   user's own numbers (I8's $5,000 threshold and I4's by-December math shipped on
   every arm); host-components-in-islands get repaired instead of refused
   (island-repair engaged 13/8/1 times per arm A/B/C across the run); the smoke gate
   runs in prod and catches real crashes instead of refusing everything.
2. **NEW platform mechanism bug (arm-blind): the guard judge approval-gates READ-ONLY
   tools called from apps**, silently starving them of data. On Maple, 43 pending
   `host_list*/get*` approvals from 8 gate apps: I14 (all three arms) shipped
   all-empty-state surfaces, and I1-B/I3-C/I7-C/I13-C shipped false "no data" regions
   with stray "Action is waiting for approval" chips on read-only views. Intermittent
   (the judge is a model — the same reads ran clean on re-open), did not recur on the
   Cadence half. Related: ~159 create-time Composio READ probes (Slack/Gmail/Calendar,
   no appId) were judge-gated across both hosts — nothing fired, but unconnected
   toolkits should not be reachable at create time at all.
3. **With refusals gone, the fail mix split by arm.** Arms A/B's new dominant class is
   the **title-only empty app** (A 7, B 5, C 0 across both hosts — every one
   reproduces on re-open). Arm C never ships an empty app but pays a different tax:
   the Kit **Callout `accent` destructure crash** rendered as a visible error note (5
   of C's fails; also seen in the rematch) and one island **units bug** (I5-C fired
   $0.25 for a typed $25 — the H4/donut-cents class at the island seam, caught at the
   approval gate).
4. **Wrong-data-binding is the top model-error class everywhere** (A 4, B 6, C 9
   incl. claim-vs-data): the checking-only "total balance" lie (3 rows), the
   wrong-category tile pair (I13, all arms — the rematch's H2 class verbatim),
   transposed tile labels, an in/out swap (I15 B+C, verified against transactions),
   season totals labeled "this week", and a false "no deadlines in the next 7 days"
   claim over rows saying "3 days away" (I20 A+C). Data-verify ran on every B/C create
   (applied 15 times total) and caught NONE of these — same conclusion as the rematch:
   copy relabeling can't fix what needs a rebind.
5. **Honesty is now a strength**: 8/9 impossible-ask attempts on Maple and 11/13 on
   Cadence handled honestly (truthful zero-states, method-transparent disclaimers,
   manual-step framing). The exceptions: one fabricated "industry overlap" analysis
   (I26-B) and one false-impossible refusal of a feasible ask (I25-B, the H4-A class).
6. **Action payloads are right at the wire seam** (I5-A/B 2500 cents; I8-A 441220
   cents; I24-B right client + firm-authored body) — every fired action was
   approval-gated and left pending/denied; zero effects landed on either host.

## Arms context

Production main now ships the FULL v4 pipeline in both demo hosts (#575) —
`{ exemplarContract, structuredRepair, regionParallel, endPass }` — which is NOT among
the arms. Arm A reproduces the rematch's production-defaults control (`pipeline: {}`)
for cross-run comparability. If the shipped config should be measured, that is a
follow-up arm on a NEW tranche (T5 is now burned).

## Integrity notes

- Blindness: T5 is commit 032cc12c, the branch's first commit, authored before any
  host boot or generation. GOLDEN.md (which contains prior tranches) was read for its
  rules/PASS bar/ledger before authoring, per the run order; no T1–T4 prompt was
  reused. One authoring-time feasibility label was corrected post-run with disclosure:
  I26 (conflict screen) was authored `[impossible]`, but roster screening is feasible
  from host data — it was judged as partially-feasible/honesty (the honest-handling
  bar either way).
- As-run vs shipped: the candidate config commit (8f3c5da0) was live for the whole run
  and REVERTED after; the PR diff vs main is docs-only. Main's runtime already logs
  pipeline events (#574), so no observability plumbing commit was needed.
- Judging: browser-judged against committed host REST ground truth; island content
  judged via frame-aware aria re-opens (`openaria`, added mid-run — harness fix, not
  tuning) per the 2026-07-20 capture-artifact precedent; rows judged FAIL only on
  violations that reproduce on re-open, except `data-starved-by-judge-gate` where the
  create-time starvation is itself the shipped experience (finding 2).
- Infra exceptions: Cadence half-runner killed once by the session harness after
  I24:C and resumed (resumable by design); ports 3100/3300 (3000 occupied by an
  unrelated session); driver caps at 420s with server conclusions committed for all
  capped rows (all six are engine refusals, zero unresolved timeouts).
- Approvals hygiene: every pending approval on both hosts is a READ or a
  denied/pending gated action; nothing was approved; the stores are local to the
  throwaway clone.
