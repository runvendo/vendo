# REMATCH GATE — Cadence half (scoring run, 2026-07-25)

Same protocol as README-MAPLE.md: main @ afa66bec, gate branch `eval/rematch-2026-07-25`,
production `next start` on port 3300, arms A/B/C by `VENDO_GATE_ARM`, arm order per the
committed randomized schedule, one attempt per prompt per arm, zero tuning. Cadence has
no paint model configured (production config), so end-pass/data-verify and repair ride
the main thinking model — repair loops routinely run past 7 minutes; the driver caps its
create-wait at 420s, so a refused create records `>420s`. Server-side outcomes for every
refusal are in `server-logs/` and distilled in `pipeline-events-cadence.json`; four rows
(`H19:B, H18:C, H24:C, H29:C`) hit the cap with NO server-side conclusion (create still
in flight when the next boot killed the server) and are classed `create-timeout`.
The store after the half contains exactly the 4 created apps (no late-landers) —
`shots/cadence-store-apps.json`.

## Results

Only 4 of 45 attempts produced an app; all four were judged in the browser
(screenshots + aria in `shots/`). The other 41 are FAILs by refusal class below.

| id | arm | verdict | timing | class-if-fail | note |
|----|-----|---------|--------|---------------|------|
| H16 | A | FAIL | >420s | create-refused (island-429302 + law-1: 1000/60/24 time constants) | |
| H16 | C | FAIL | >420s | create-refused (law-1 time constants) | |
| H16 | B | PASS | 16.1s | — | "Tax season at a glance": 8/12 clients missing docs, 38+21=59 docs consistent, nearest deadline Jul 27 matches its own table (Blue Bottle), full filterable per-client table, formatted, no errors. The best app of the run. |
| H17 | C,A,B | FAIL ×3 | >420s | create-refused (law-1 / host `<CadenceStatusBadge>` in island / island-429302) | Deadline-risk ask hits date-math constants + the island wall on all arms. |
| H18 | A,B | FAIL ×2 | >420s | create-refused (host components in island / island-429302) | |
| H18 | C | FAIL | >420s | create-timeout (no server-side conclusion) | |
| H19 | C,A | FAIL ×2 | >420s | create-refused (island-429302, host-comp-in-island) | |
| H19 | B | FAIL | >420s | create-timeout | |
| H20 | B,A,C | FAIL ×3 | >420s | create-refused (law-1 / host-comp-in-island / island-429302) | |
| H21 | B,C,A | FAIL ×3 | >420s | create-refused (host-comp-in-island / island-429302 + law-1) | The "nudge one" action ask never got to an action. |
| H22 | C,A,B | FAIL ×3 | >420s | create-refused (island-429302 / host-comp + unknown-reference ×2) | |
| H23 | C | FAIL | >420s | create-refused (island-429302) | |
| H23 | A | FAIL | >420s | create-refused (host-comp-in-island) | |
| H23 | B | PASS | 70.5s | — | "Partners' meeting — weekly recap": correct week header (2026-07-20→26), consistent hero stats, real activity rows all within the stated week, formatted. Wart: season-wide doc tiles under a weekly header (labels don't claim "this week", so not a literal lie). |
| H24 | A | FAIL | >420s | create-refused (law-1) | |
| H24 | B | FAIL | >420s | create-refused (island-429302 + host-comp) | |
| H24 | C | FAIL | >420s | create-timeout | Partially-feasible ask (message half feasible) never landed on any arm. |
| H25 | C,A,B | FAIL ×3 | >420s | create-refused (island-429302 + law-1 / island-429302 / host-comp) | |
| H26 | A,B,C | FAIL ×3 | >420s | create-refused (host-comp + unknown-ref / island-429302 + law-1 / island-429302) | An [impossible] ask (no calendar tools) where the honest-disclaimer path never survived validation on any arm. |
| H27 | A | PASS | 18.5s | — | Honest impossible: "About this view — direct IRS e-file acknowledgement status is not available through this host" + truthful document-collection fallback labeled as such. Wart: the display name "E-filed return status" still echoes the impossible ask. |
| H27 | B | PASS | 20.6s | — | Same handling, same wart; "IRS e-file status not available" note + honest readiness table. |
| H27 | C | FAIL | >420s | create-refused (island-429302) | |
| H28 | A,B,C | FAIL ×3 | >420s | create-refused (island-429302 + host-comp ×2 / island-429302) | |
| H29 | A,B | FAIL ×2 | >420s | create-refused (island-429302 + host-comp) | |
| H29 | C | FAIL | >420s | create-timeout | |
| H30 | C,B,A | FAIL ×3 | >420s | create-refused (island-429302 / island-429302 / island-429302 + law-1) | |

## Summary — Cadence

**Arm A: 1/15 PASS** (H27) · **Arm B: 3/15 PASS** (H16, H23, H27) · **Arm C: 0/15 PASS**.

### Fails by class per arm (a refusal may carry several classes; primary listed)

| class | A | B | C |
|-------|---|---|---|
| create-refused, island smoke-crash (the 429302 environment bug) | 6 | 6 | 9 |
| create-refused, host component inside island | 5 | 4 | 0 |
| create-refused, law-1 constants (time/date math: 1000, 60, 24, 7…) | 3 | 1 | 3 |
| create-refused, unknown-reference | 0 | 1 | 0 |
| create-timeout (no server conclusion within the cap) | 0 | 1 | 3 |

### Mechanism + timing

| | A | B | C |
|---|---|---|---|
| created / attempts | 1/15 | 3/15 | 0/15 |
| data-verify ran / applied | — (off) | 3 / 0 | 0 / 0 |
| timing p50 / p95 (attempt wall-clock; refusals capped at 420s) | 420.7s / 422.0s | 420.6s / 421.4s | 421.1s / 421.7s |
| created-only timings | 18.5s | 16.1 / 70.5 / 20.6s | — |

### The headline

Cadence is where the refusal wall becomes absolute: 41/45 attempts produced NO app.
Three compounding causes, all mechanical:

1. **The island smoke-crash environment bug** (same constant-429302 signature as Maple —
   see README-MAPLE and the root-cause note in the PR body): every island-bearing app
   dies in the gate regardless of arm.
2. **Cadence prompts want islands and badges**: the models constantly reach for
   `<CadenceStatusBadge>`/`<Skeleton>` INSIDE islands (17 refusals carry that class) and
   date-difference math whose 1000/60/60/24 constants law-1 rejects (11 refusals).
3. **No paint model on Cadence** makes each repair round minutes long, so a doomed create
   burns 7-11 minutes before refusing — the practical UX is "nothing happens for 7
   minutes, then an error".

When a create survived, quality was good: H16-B is an exemplary dashboard and both H27
apps handle an impossible ask honestly.
