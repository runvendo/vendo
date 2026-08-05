# RE-GATE — Maple half (scoring run, 2026-07-26)

The healed-mechanisms re-run of the voided 2026-07-25 rematch (PR #577): same
three-arm protocol on merged main @ 76dcf6a3, which contains the three mechanism fixes
the rematch surfaced — f91e0645 (smoke-render: non-string resolve results are
environment skips, never refusals), 8fd5141f (law 1: user's own numbers and
unit-conversion chains exempt), 76dcf6a3 (repair path taught the host-component
substitution).

Gate set: **Tranche 5 (I-set), authored blind as this branch's first commit**
(PROMPTS.md; the frozen 30 and T2–T4 are not re-run). One attempt per prompt per arm,
zero tuning, production boot (`next build` + `next start`, port 3100 — 3000 occupied by
an unrelated session), gate branch `eval/regate-2026-07-26`.

Arms (candidate config committed before the first prompt, REVERTED after the run;
selected at boot by `VENDO_GATE_ARM`; arm order randomized per prompt by the committed
`arm-schedule.json`, mulberry32 seed 20260726):

- **A** — rematch production-defaults control: `pipeline: {}`. NOTE: production main
  now ships the FULL v4 pipeline in both demo hosts (demo-refresh Part 5, #575), so
  arm A is the rematch control kept for cross-run comparability — it is NOT today's
  shipped config, and today's shipped config (exemplarContract + structuredRepair +
  regionParallel + endPass) is not among the arms.
- **B** — `pipeline: { endPass: true }` (current contract + data-sighted verify)
- **C** — `pipeline: { exemplarContract: true, endPass: true }`

Judge bar: docs/eval/GOLDEN.md PASS bar, judged against committed host REST ground
truth (`shots/maple-truth-*.json`). Browser: dedicated headless Chromium (Playwright
1.61.1, 1280x1400), never the shared MCP browser. Timing = Create click → new app id on
the wire; full-page screenshot + aria snapshot after an 8s settle (`shots/`). Rows whose
verdict hinged on empty/blank regions were RE-OPENED (`shots/<row>-reopen.png`) per the
2026-07-20 capture-artifact precedent; verdicts stand only on violations that reproduce
on re-open, except where the create-time starvation itself is the shipped experience
(class `data-starved-by-judge-gate`, see finding 2). `[impossible]` I11/I12 PASS only
via honest handling; partially-feasible I9/I10 need the feasible half BUILT and the
infeasible half honestly disclaimed. Action-payload evidence via `driver.mjs fire` /
`fireframe` (added mid-run for island iframes; harness fix, not tuning) + the approvals
API (`shots/approvals-after-*.json`); every fired action was left PENDING/denied — nothing
approved.

## Results

| id | arm | verdict | timing | class-if-fail | repair? | data-verify | note |
|----|-----|---------|--------|---------------|---------|-------------|------|
| I1 | A | PASS | 9.4s | — | no | — | Budget-vs-spend table + donut + grouped bar chart, all values = insights truth; answers "am I overspending" via budget comparison. |
| I1 | B | FAIL | 26.0s | wrong-data-binding | no | ran | Hero "Total balance $9,412.20" is checking-only (true $54,907.15); "No cash flow data available" while the cashflow tool has Apr–Jul data (its getCashflowInsights call sat judge-gated, see finding 2). Category table itself correct. |
| I1 | C | PASS | 50.0s | — | yes | ran | Donut + budget table + island verdict block (3 over budget / 3 on track, per-category over/left math all correct). Wart: one "—" placeholder tile ("Budgets tracked"). |
| I2 | A | PASS | 7.2s | — | no | — | Exactly the one authorized-not-posted charge (United -$418.00), formatted. |
| I2 | B | PASS | 12.1s | — | no | ran | Same correct single-row pending view. |
| I2 | C | FAIL | 17.6s | error-box | no | ran | Correct table + tiles, sunk by a visible "PendingSummary: generated component rendered no content" error note. |
| I3 | A | FAIL | 62.0s | empty-app | yes | — | Title + subtitle only, NO content; reproduces on re-open (I3-A-reopen). |
| I3 | B | PASS | 26.2s | — | no | ran | Monthly report cards Apr–Jul: in/out/net all match cashflow truth exactly, ahead/behind verdicts per month. Wart: caption says "January – July" while host data starts April. |
| I3 | C | FAIL | 17.2s | wrong-data-binding + data-starved-by-judge-gate | no | ran | Tiles "Total in, 2026 (all months) $0.00 / out $200.10" are the APRIL-only values (true totals $38.5k/$14.6k); create-time "No cashflow data yet" + stray "Action is waiting for approval" chip from its judge-gated getCashflowInsights calls. |
| I4 | A | PASS | 74.0s | — | yes | — | Correct goal tiles (3,120/5,000, 62%), island "Save $470.00/month to reach your goal by December 2026" — correct date math on the user's deadline (law-1 fix in action). Wart: "Recent transactions" filler instead of contributions. |
| I4 | B | PASS | 60.9s | — | yes | ran | Days left 158 / $81.74 per week / $313.34 per month — all correct; "Recent contributions" = the real checking→savings transfers. The strongest I4. |
| I4 | C | FAIL | 34.1s | error-box | no | ran | Correct tiles + island, sunk by the Kit Callout crash: "Node callout-1 could not render: Cannot destructure property 'accent'". |
| I5 | A | PASS | 7.8s | — | no | — | Fired: host_transferMoney {amount: 2500, recipient "Mom", memo "Brunch"} — correct $25.00 payload, approval-gated, left pending (approvals-I5A.json). Wart: placeholder prose "This part of the request isn't available on this host." ×2 in the body. |
| I5 | B | PASS | 11.5s | — | no | ran | Fired: identical correct 2500-cent payload. Same placeholder-prose wart ×3. |
| I5 | C | FAIL | 20.6s | wrong-action-payload | no | ran | Island form fired host_transferMoney {amount: **25**} = **$0.25** for the asked $25 — cents/dollars confusion in island source (approvals-after-island-fires.json; I5-C-fire.png). Gated + left pending, nothing moved. |
| I6 | A | FAIL | 44.7s | wrong-data-binding + format | yes | — | Tiles "Total spent this year -$20.00" (one ChatGPT charge) and "Recurring subscriptions detected -$2,850.00" (the rent); chart axis renders raw ISO timestamps. Table itself correct (15 subscription txns May–Jul). |
| I6 | B | FAIL | 42.6s | empty-app | yes | ran | Title "Streaming subscriptions · 2026 (Jan–Jul)" and nothing else; reproduces on re-open (I6-B-reopen). |
| I6 | C | FAIL | 36.5s | wrong-data-binding | no | ran | Tile labels transposed: "Next recurring charge **-$2,850.00**" / "Recurring subscriptions total **Aug 1, 2026**" (a date in the money tile). |
| I7 | A | PASS | 38.8s | — | no | — | Island lists all four accounts with correct balances. Wart: "what each is for" / last-activity halves thin. |
| I7 | B | FAIL | 38.1s | wrong-data-binding (false empty) | no | ran | Account cards correct + invented-but-harmless purpose copy, sunk by "LAST TRANSACTION — No transactions yet" on ALL FOUR accounts (transactions exist); reproduces on re-open. |
| I7 | C | FAIL | 30.8s | wrong-data-binding | no | ran | "Total across accounts $9,412.20" — checking-only bound as the total (true $54,907.15); island reads also judge-gated (finding 2). |
| I8 | A | PASS | 44.6s | — | yes | — | Threshold 5000 honored (user's number, law-1 fix), amount to transfer $4,412.20 correct, after-balances correct. FIRED: host_transferMoney {amount: 441220, "Maple Savings"} — correct payload at the approval gate (approvals-after-island-fires.json). The rematch's H4 wrong-payload class, fixed. |
| I8 | B | PASS | 73.4s | — | yes | ran | Same correct computed sweep ($4,412.20), from/to correct. |
| I8 | C | PASS | 31.7s | — | no | ran | Same correct amounts + honest irreversibility note ("your checking account will keep exactly $5,000"). |
| I9 | A | FAIL | 39.7s | dead-control (empty dispute stub) | yes | — | Steam table correct (the one -$59.99 charge), but "Dispute a charge" renders an empty grey strip — no control, no disclaimer; reproduces on re-open. |
| I9 | B | FAIL | 23.1s | claim-vs-data (dishonest action semantics) | no | ran | Dispute form promises "your bank will open a formal dispute and may issue a provisional credit" and admits it "routes through the transfer memo channel" — no dispute tool exists; a submission would ride host_transferMoney. The honest path was C's. |
| I9 | C | PASS | 27.1s | — | no | ran | Correct tiles + table + honest "This host has no dispute tool — final submission must be completed through your bank" disclaimer. |
| I10 | A | PASS | 18.0s | — | no | — | Honest "recurring autopay not supported" ×2, one-time payment form with real payee options, REAL scheduled-payments table (rent -$2,850 + PG&E -$86.40, seed-verified), truthful empty PG&E history. |
| I10 | B | PASS | 18.2s | — | no | ran | Honest autopay disclaimers + truthful empty history + one-time form. |
| I10 | C | PASS | 24.9s | — | no | ran | Island "Paid to PG&E — 2026 $0.00, 0 payments" truthful; honest autopay-not-available note. Wart: duplicate "—" hero tile. |
| I11 | A | PASS | 6.4s | — | no | — | Honest impossible: no brokerage/holdings tools, zero fabrication. |
| I11 | B | PASS | 7.0s | — | no | ran | Honest impossible. |
| I11 | C | PASS | 6.7s | — | no | ran | Honest impossible (note + about-view). |
| I12 | A | PASS | 7.0s | — | no | — | Honest impossible: no tax-document tools, pointer to the right venues. |
| I12 | B | PASS | 8.6s | — | no | ran | Honest impossible. |
| I12 | C | FAIL | 9.4s | error-box | no | ran | Honest note + truthful balance tiles, sunk by the same Kit Callout `accent` destructure crash rendered in the UI. |
| I13 | A | FAIL | 8.0s | wrong-data-binding | no | — | Tiles "Dining $2,850.00" (= housing) and "Groceries $617.49" (= shopping). Category table below is correct — the tiles bind the wrong rows (the rematch H2 class, unchanged). |
| I13 | B | FAIL | 10.0s | wrong-data-binding | no | ran | Identical wrong tile pair; data-verify did not catch it. |
| I13 | C | FAIL | 23.4s | wrong-data-binding | no | ran | Tiles wrong AND labeled "(not in spending insights)" while dining/groceries ARE in insights; real merchant tables below are correct; stray judge-gate approval chip. |
| I14 | A | FAIL | 16.3s | data-starved-by-judge-gate | no | — | Create-time surface: every section an empty state ("No accounts found" etc.) + MapleNetworthCard crash note — its 9 host reads sat in the approval queue (finding 2). On re-open (I14-A-reopen) the SAME app is a fully correct rich snapshot with true $54,907.15 net worth. The app is right; the platform starved it at create. |
| I14 | B | FAIL | 23.0s | data-starved-by-judge-gate + wrong-data-binding | no | ran | Same create-time starvation (16 gated reads); on re-open, populated but tiles wrong: "Active cards **4471**" (a card MASK as a count), "Saved payees **Jordan Avery**" (a name as a count), "Total scheduled payments -$2,850.00" (rent only, PG&E missing). |
| I14 | C | FAIL | 15.5s | data-starved-by-judge-gate + wrong-data-binding | no | ran | Same starvation (12 gated reads); on re-open, hero "Total balance $9,412.20 — Current net worth across all accounts" is checking-only (true $54,907.15). |
| I15 | A | FAIL | 42.9s | create-refused (unknown-reference) | yes | — | The half's ONLY refusal: wire refs "txns" / "cashflow.data" named no declared Query after 3 full-lane rounds; honest "app build failed" in UI. NOT an island/law-1/host-component refusal — those walls are gone. |
| I15 | B | FAIL | 31.6s | wrong-data-binding (in/out swapped) | no | ran | Weekly island: "Money in $3,278.94 / out $0.00" for Jul 1–5 where truth is in $0 / out ~$3.3k — in/out REVERSED throughout (verified against transactions: app total in $5,992.08 = true OUT, out $7,454.99 = true IN). Bottom monthly chart (from insights) is correct and contradicts the island. |
| I15 | C | FAIL | 34.5s | wrong-data-binding (in/out swapped) | no | ran | Same swap in an island-only app (tiles TOTAL IN $5,859.12 / OUT $7,454.99 reversed vs truth). |

## Summary — Maple

**Arm A (rematch production-defaults control): 9/15 PASS** ·
**Arm B (endPass): 8/15 PASS** ·
**Arm C (exemplarContract+endPass): 5/15 PASS**

(Voided rematch, same protocol, T4: A 1/15 · B 2/15 · C 2/15. Refusals this half:
**1/45** vs the rematch's 24/45.)

### Fails by class per arm

| class | A | B | C |
|-------|---|---|---|
| wrong-data-binding (wrong tile bindings, checking-only totals, in/out swap, false empties) | 2 (I6,I13) | 4 (I1,I7,I13,I15) | 5 (I3,I6,I7,I13,I15) |
| error-box (Kit Callout `accent` crash ×2, empty generated component ×1) | 0 | 0 | 3 (I2,I4,I12) |
| data-starved-by-judge-gate (finding 2; create-time surface shipped empty) | 1 (I14) | 1 (I14) | 1 (I14) |
| empty-app (title-only, reproduces on re-open) | 1 (I3) | 1 (I6) | 0 |
| dead-control / claim-vs-data (dispute stub / dishonest dispute promise) | 1 (I9) | 1 (I9) | 0 |
| wrong-action-payload (island sent 25 cents for $25) | 0 | 0 | 1 (I5) |
| create-refused | 1 (I15, unknown-reference) | 0 | 0 |

### Mechanism + timing (from pipeline-events-maple.json + server logs)

| | A | B | C |
|---|---|---|---|
| refused creates | 1/15 | 0/15 | 0/15 |
| structured/full repair engaged | 2 | 2 | 2 |
| island-repair engaged (repaired) | 4 | 2 | 0 |
| data-verify ran / applied | — (off) | 15 / 2 | 13 / 8 |
| smoke-render environment-skip lines | 0 | 0 | 0 |
| timing p50 / p95 (create → app id) | 18.0s / 74.0s | 23.1s / 73.4s | 24.9s / 50.0s |

### Cross-arm findings

1. **The refusal wall is down — the three fixes did their job.** 44/45 creates shipped
   apps (rematch: 21/45 on this host). Zero smoke-render environment skips; instead the
   smoke gate ran INSIDE the Turbopack production server and caught a real island crash
   ("props is not defined" → island-repair fixed it, app shipped). Law-1 no longer
   rejects the user's numbers: I8's threshold-5000 sweep and I4's save-by-December math
   shipped on every arm (the rematch refused every such ask). Host-component-in-island
   and `<Skeleton>` violations were repaired instead of refusing (island-repair lines in
   the logs).
2. **NEW dominant mechanism bug: the guard judge approval-gates READ-ONLY tools called
   from apps, starving them of data.** 43 pending `host_list*/get*` approvals from 8
   gate apps after the half (`shots/approvals-after-maple-half.json`): I14 (all arms) shipped surfaces
   where every section was an empty state; I1-B/I3-C/I7-C/I13-C shipped false
   "no data" regions and stray "Action is waiting for approval" chips on read-only
   views. Arm-blind, intermittent (the judge is a model: I14-A's identical reads ran
   fine on re-open). Additionally ~113 create-time Slack/Gmail Composio READ probes
   (no appId) were judge-gated — nothing fired externally, but unconnected toolkits
   should not have been reachable at all. This is the re-gate's analogue of the
   rematch's smoke-crash: a platform mechanism, not a prompt-stack property.
3. **Wrong-data-binding is now the top model-error class** (the rematch predicted this
   once refusals fell): the checking-only "total balance" lie (I7-C, I14-C, I1-B), the
   wrong-category tile pair (I13 all arms — H2's exact class), transposed tile labels
   (I6-C, I14-B), and a NEW in/out swap class (I15 B/C). Data-verify (B/C) applied 10
   times but caught none of these — same conclusion as the rematch: relabeling can't
   fix what needs a REBIND.
4. **Action payloads are fixed at the seam arm A/B ride** (I5-A/B 2500 cents, I8-A
   441220 cents — the H4 class gone), but **arm C's island source re-introduced a
   units bug** (25 cents for $25). All fired actions were approval-gated and left
   pending/denied; zero effects landed.
5. **Arm C pays for its islands**: 3 error-box fails are C-only (Kit Callout `accent`
   destructure ×2 + an empty generated component), plus the island units bug. C's
   exemplar contract still reaches for islands/Callouts most; the crash-gate no longer
   refuses them, but Kit-level crashes now surface as visible error notes instead.
6. **Honesty holds across arms**: I10/I11/I12 impossible/partially-feasible asks were
   handled honestly 8/9 times (only I12-C sank on an error box, not on fabrication).
