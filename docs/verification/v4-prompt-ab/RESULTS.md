# v4 create-prompt rewrite — offline A/B results (2026-07-20)

**This is the OFFLINE leg.** No hosts were booted, nothing was rendered, no
screenshots were taken, and queries never executed — the judge saw wire markup
only. The rendered/pairwise-screenshot leg happens at the next gate; numbers
here measure validity, cost, and judged wire quality, not browser-judged
error-free rate.

## Setup

- **Arms** (selected per-create via `GenerationDependencies.pipeline`):
  - **ARM A** — current contract: `pipeline: {}` (structured repair on by default)
  - **ARM B** — v4 contract: `pipeline: { promptRewrite: true, endPass: true }`
    (rewritten create contract + sharpened end pass; the two flags ship together
    in this arm, so their effects are NOT separable here — caveat below)
- **Deps**: real per-host deps from the demo hosts' `.vendo/` files —
  catalog, tools, `semantics.tools` → semantics, `semantics.domains` → domains,
  theme, and `design-rules.md` → `designRules`. Design rules fed **both** arms
  (they reach the prompt in both). Auth/demo-control/voice tools filtered
  identically for both arms. **No `toolShapes`** were provided (no live host to
  sample), so binding field names were unverifiable in BOTH arms — several
  judge notes hinge on field-name guesses that the rendered leg would settle.
- **Models**: generator `claude-sonnet-4-6` (both arms), judge
  `claude-opus-4-8` (bench `client.ts` pattern). No paint lane (no
  `onPartial`), no extra thinking budget.
- **Harness**: `packages/apps/src/bench/v4ab.live.test.ts`
  (`V4AB_MODE=create` / `V4AB_MODE=judge`), calling `modelEngine.create`
  directly. Raw per-run records (timing, pipeline events, wire, document):
  `runs/*.json`. Aggregation: `aggregate.py`.
- **Runs**: 12 prompts × 2 arms × 2 fresh attempts = 48 creates, then blind
  pairwise judging ("App 1"/"App 2", both orderings; a win requires both
  orderings to agree, else tie) = 24 judge calls.

## The 12 prompts

Authored blind BEFORE any run (see `PROMPTS.md`; frozen tranches and the DEV
list were not read first). Burned to GOLDEN.md's DEV list per rule 4.

| id | host | archetype | feasibility | prompt |
|---|---|---|---|---|
| AB-M1 | demo-bank | dashboard | partial | A money overview dashboard: my account balances, my spending by category this month, and how my stock portfolio has performed this quarter. |
| AB-M2 | demo-bank | worklist+action | feasible | List my upcoming scheduled payments with amounts and due dates, and let me pay the next one right now from my checking account. |
| AB-M3 | demo-bank | detail | feasible | A detail view for my checking account: the current balance, account number, and its recent transactions with each one's status. |
| AB-M4 | demo-bank | form/flow | feasible | A send-money flow: pick one of my saved payees, enter an amount and a note, review the details, then send it from checking. |
| AB-M5 | demo-bank | board/timeline | feasible | A timeline of money leaving my account soon: upcoming scheduled payments and subscription renewals, ordered by date with the total going out. |
| AB-M6 | demo-bank | report | impossible | An annual tax summary report: my capital gains, deductible expenses, and how much tax I'll owe this year. |
| AB-C1 | demo-accounting | dashboard | partial | A Monday-morning practice overview: how many clients are missing documents, documents outstanding versus received, the nearest filing deadlines, and the revenue we billed this month. |
| AB-C2 | demo-accounting | worklist+action | feasible | A chase list: clients with outstanding documents ranked worst-first, and let me send one of them a reminder message without leaving the page. |
| AB-C3 | demo-accounting | detail | feasible | A single client's page: their document checklist with per-document status, who on our staff is assigned, and the latest messages between us and them. |
| AB-C4 | demo-accounting | form/flow | feasible | A document review flow: pick a client, look through their uploaded documents, and verify or reject each one with a note to the client. |
| AB-C5 | demo-accounting | board/timeline | feasible | A deadlines board grouping clients by urgency — filing deadline this week, this month, and later — with each client's document progress on their card. |
| AB-C6 | demo-accounting | report | impossible | A billing report for the quarter: hours logged per client and the invoices we should be sending out. |

## Per-prompt, per-arm metrics

Cell format: `first-attempt-valid / <full attempts>fa+<repair rounds>rr / wall / output tokens`.
"First-attempt valid" = the create resolved with one full-lane attempt and
zero repair rounds.

| prompt | arm A a1 | arm A a2 | arm B a1 | arm B a2 | pairwise |
|---|---|---|---|---|---|
| AB-M1 | yes / 1fa+0rr / 7s / 433tok | yes / 1fa+0rr / 7s / 447tok | yes / 1fa+0rr / 11s / 596tok | no / 1fa+1rr / 12s / 478tok | **tie** (AB=A, BA=B) |
| AB-M2 | no / 2fa+0rr / 31s / 2128tok | no / 1fa+1rr / 11s / 579tok | yes / 1fa+0rr / 21s / 1751tok | yes / 1fa+0rr / 22s / 1552tok | **tie** (AB=B, BA=A) |
| AB-M3 | yes / 1fa+0rr / 7s / 446tok | yes / 1fa+0rr / 7s / 419tok | no / 3fa+0rr / 46s / 3226tok | no / 2fa+0rr / 29s / 2233tok | **B** (AB=B, BA=B) |
| AB-M4 | no / 2fa+0rr / 102s / 8819tok | no / 2fa+0rr / 91s / 8071tok | yes / 1fa+0rr / 37s / 3033tok | yes / 1fa+0rr / 35s / 2724tok | **tie** (AB=tie, BA=tie) |
| AB-M5 | no / 2fa+0rr / 43s / 3347tok | no / 2fa+0rr / 51s / 4182tok | yes / 1fa+0rr / 35s / 2758tok | yes / 1fa+0rr / 26s / 2051tok | **B** (AB=B, BA=B) |
| AB-M6 | yes / 1fa+0rr / 16s / 1017tok | yes / 1fa+0rr / 22s / 1057tok | yes / 1fa+0rr / 12s / 658tok | no / 1fa+1rr / 22s / 762tok | **A** (AB=A, BA=A) |
| AB-C1 | no / 1fa+1rr / 18s / 1138tok | no / 1fa+1rr / 14s / 782tok | yes / 1fa+0rr / 24s / 1609tok | yes / 1fa+0rr / 14s / 645tok | **tie** (AB=A, BA=B) |
| AB-C2 | yes / 1fa+0rr / 26s / 1894tok | **HARD-FAIL** (113s, 3fa) | yes / 1fa+0rr / 52s / 3939tok | yes / 1fa+0rr / 33s / 2384tok | **A** (AB=A, BA=A) |
| AB-C3 | yes / 1fa+0rr / 35s / 2810tok | yes / 1fa+0rr / 34s / 2700tok | yes / 1fa+0rr / 45s / 3614tok | yes / 1fa+0rr / 60s / 4697tok | **A** (AB=A, BA=A) |
| AB-C4 | **HARD-FAIL** (148s, 3fa) | no / 2fa+0rr / 100s / 8648tok | yes / 1fa+0rr / 52s / 4135tok | yes / 1fa+0rr / 45s / 3806tok | **tie** (AB=B, BA=A) |
| AB-C5 | yes / 1fa+0rr / 22s / 1647tok | yes / 1fa+0rr / 21s / 1647tok | yes / 1fa+0rr / 47s / 3351tok | yes / 1fa+0rr / 37s / 3019tok | **A** (AB=A, BA=A) |
| AB-C6 | yes / 1fa+0rr / 18s / 1129tok | yes / 1fa+0rr / 12s / 607tok | yes / 1fa+0rr / 15s / 812tok | yes / 1fa+0rr / 12s / 438tok | **A** (AB=A, BA=A) |

Both hard failures were ARM A ("model could not produce a valid app" after 3
full attempts: AB-C2 a2, AB-C4 a1). Judging used each arm's first successful
attempt.

## Headline numbers

| metric | arm A (current) | arm B (v4 rewrite + end pass) |
|---|---|---|
| first-attempt validity | 13/24 (54%) | **20/24 (83%)** |
| runs needing repair rounds | 3/24 (12%) | 2/24 (8%) |
| hard failures | 2/24 (8%) | **0/24 (0%)** |
| median wall-clock | **21.9s** | 31.1s |
| mean wall-clock | 39.9s | **31.1s** |
| mean output tokens | 3160 | **2261** |
| pairwise judge (win/loss/tie) | **5W** | 2W (5 ties) |

Latency shape: arm A is bimodal — small prompts resolve in ~7s, but its
retries blow out the tail (91-148s, four runs over 90s); arm B is more
consistent (12-60s, worst case 60s). B's higher median reflects it writing
richer apps on the simple prompts, not slowness per se.

## Pairwise verdicts — what drove them

- **B wins (M3, M5)**: A hardcoded a `"checking"` account id / index-0 account
  and invented an unrequested net-worth card (M3); A's island read props never
  wired from its queries, rendering empty, while B fetched and formatted
  correctly (M5).
- **A wins (M6, C2, C3, C5, C6)**: on both impossible/report prompts the judge
  preferred A's more granular per-item disclaimers and framing; on Cadence, B
  repeatedly guessed the response envelope wrong (`hostGetClient.name` instead
  of `.data.name`, a broken hero `Stat` binding, an odd urgency sort) — the
  binding-truth class the end pass was supposed to catch.
- **Ties**: M4 was a genuine both-orderings tie (both flows correct); the other
  4 ties are ordering disagreements (position bias) — the judge flipped with
  presentation order on M1, M2, C1, C4, i.e. the docs were close.

## Verdict: ITERATE (do not adopt as-is, do not reject)

The v4 rewrite delivers exactly what it was built for — **reliability and
cost**: +29pt first-attempt validity (54%→83%), zero hard failures vs two,
−28% mean output tokens, −22% mean wall-clock, and a far better worst case
(60s vs 148s). If the offline metric were validity alone, this would be an
adopt.

But the pairwise quality read says the rewritten contract gives some of that
back: A won 5 pairwise to B's 2. The loss pattern is concentrated and
nameable:

1. **Response-envelope binding guesses on Cadence** (`.data` path drops,
   wrong hero field) — B's exemplars are Maple-flavored and the sharpened end
   pass (cap 4 ops) did not catch these. Notably the end pass ran on every B
   create but applied changes on only 3 of 24 runs.
2. **Impossible-ask framing** — A's per-item disclaimers beat B's single
   coarser disclaimer on both report prompts (M6, C6).

Caveats before treating this as final:

- The two flags are confounded (promptRewrite + endPass measured together).
- No `toolShapes` were wired (offline leg), so field-name errors that shape
  the judge's Cadence verdicts are exactly the ones a live host's shape cards
  + shape-mismatch repair would flag — the rendered leg may look different for
  both arms.
- n=12 prompts / 24 runs per arm; 4 of 5 ties were judge position-bias flips.
- The judge read wire markup, not pixels; composition quality is only
  partially visible offline.

Recommended iteration before the next gate: teach the v4 exemplars the
response-envelope discipline (one Cadence exemplar with `.data` paths), fold
A's per-item disclaimer style into the v4 impossible-ask section, and consider
raising the end-pass adoption rate — then re-run this A/B (fresh prompts) or
take it straight to the rendered leg.

## Reproduce

```
cd packages/apps
V4AB_MODE=create pnpm exec vitest run src/bench/v4ab.live.test.ts   # resumable
V4AB_MODE=judge  pnpm exec vitest run src/bench/v4ab.live.test.ts
python3 ../../docs/verification/v4-prompt-ab/aggregate.py
```

`ANTHROPIC_API_KEY` required (canonical: `/Users/yousefh/orca/workspaces/flowlet/.env`).
