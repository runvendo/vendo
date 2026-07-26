# Re-gate design pairwise — 2026-07-26

Protocol identical to the rematch/v4-gate: claude-opus-4-8, blind labels, both
orderings per pair, agreement rule (disagreement = TIE), shipped pairs only
(a pair is skipped when either arm's create produced no app). Inputs are the
create-time screenshots resampled to width 800 (`shots-800/`). Criteria: visual
hierarchy, layout balance, density consistency, humanized labels, brand feel,
designed empty states — feature count explicitly excluded. Raw verdicts:
`design-pairwise.json`.

## Tallies

| comparison | candidate wins | control wins | ties | skipped (no shipped pair) |
|---|---|---|---|---|
| **B-vs-A** | **10** | 6 | 8 | 6 |
| **C-vs-A** | **11** | 9 | 6 | 4 |

Both candidates edge the control on design without dominating it. C's wins cluster on
Cadence (I16/I17/I19/I20/I22/I23/I25 — its islands produce populated, structured
surfaces where A ships plainer documents or title-only shells); its losses cluster on
Maple where its error notes and placeholder tiles show on screen (I2/I4/I12/I13/I14).
B's wins similarly concentrate where arm A shipped empty or plainer views (I3, I7, I9,
I12, I14, I17, I19, I20, I23, I26).

Note the design judge sees only visual quality — several pairwise "wins" are rows that
FAILED the correctness bar (e.g. I20-C wins C-vs-A while failing on the false
"next 7 days" claim). Design preference and PASS-bar truthfulness remain different
axes; the PASS scores in the half READMEs are the quality numbers.
