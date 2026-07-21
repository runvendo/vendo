# Design pairwise — v4 gate (2026-07-21) vs baseline (2026-07-20)

Per the v4 spec's design leg: for every prompt present in BOTH runs (frozen 30 + F1–F10),
the two primary screenshots were judged by **claude-opus-4-8** with blind labels (A/B),
in BOTH orderings; a win counts only when both orderings agree, otherwise TIE. Judge
criteria: hierarchy (one clear hero), layout balance (no dead space / floating cards),
density consistency, humanized labels (no raw enums/cents/ISO), brand feel, designed
empty states. Feature count explicitly excluded. Raw verdicts: `design-pairwise.json`.
Images resampled to width 800; the new run's screenshots use the corrected full-paint
capture protocol (baseline screenshots are as committed on 2026-07-20).

## Aggregate

| | wins |
|---|---|
| **NEW (v4 gate run)** | **17** |
| BASELINE (2026-07-20) | 13 |
| TIE (orderings disagreed or judged even) | 10 |

Split by host: **Maple 11W–2L–7T for NEW** · **Cadence 6W–11L–3T for BASELINE**.
The v4 prompt stack reads as a design improvement on Maple and a design regression on
Cadence (where several new-run fails — C11's error blob, C13's dead form — also lose on
looks, and the baseline's island-rendered boards were strong).

## Per-prompt verdicts

| id | o1 (A=new) | o2 (A=baseline) | verdict |
|----|-----------|-----------------|---------|
| M1 | B | B | TIE |
| M2 | B | B | TIE |
| M3 | B | B | TIE |
| M4 | A | B | NEW |
| M5 | B | B | TIE |
| M6 | A | B | NEW |
| M7 | B | B | TIE |
| M8 | A | B | NEW |
| M9 | A | B | NEW |
| M10 | A | B | NEW |
| M11 | B | B | TIE |
| M12 | A | B | NEW |
| M13 | A | B | NEW |
| M14 | B | A | BASELINE |
| M15 | A | B | NEW |
| C1 | A | B | NEW |
| C2 | A | B | NEW |
| C3 | B | A | BASELINE |
| C4 | B | A | BASELINE |
| C5 | B | B | TIE |
| C6 | B | A | BASELINE |
| C7 | B | B | TIE |
| C8 | A | B | NEW |
| C9 | B | A | BASELINE |
| C10 | A | B | NEW |
| C11 | B | A | BASELINE |
| C12 | B | A | BASELINE |
| C13 | B | A | BASELINE |
| C14 | B | A | BASELINE |
| C15 | B | A | BASELINE |
| F1 | A | B | NEW |
| F2 | B | B | TIE |
| F3 | A | B | NEW |
| F4 | A | B | NEW |
| F5 | B | A | BASELINE |
| F6 | A | B | NEW |
| F7 | A | B | NEW |
| F8 | B | A | BASELINE |
| F9 | B | A | BASELINE |
| F10 | A | A | TIE |
