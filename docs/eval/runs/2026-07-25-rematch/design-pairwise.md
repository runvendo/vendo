# Design pairwise — rematch gate (2026-07-25), B-vs-A and C-vs-A

Per the rematch spec's design leg: for every T4 prompt, the arm-B and arm-C primary
screenshots were judged against arm-A's by **claude-opus-4-8** with blind labels (A/B),
in BOTH orderings; a win counts only when both orderings agree, otherwise TIE. Judge
criteria: hierarchy (one clear hero), layout balance, density consistency, humanized
labels, brand feel, designed empty states; feature count explicitly excluded. Images
resampled to width 800. Raw verdicts: `design-pairwise.json`.

**Countable pairs are only those where BOTH sides shipped an app** — with 24/45 Maple and
41/45 Cadence attempts refusing, the screenshot of a refused create is the apps page
with an error line, not an app. That leaves 8 valid B-vs-A pairs and 4 valid C-vs-A
pairs. The uncountable comparisons are retained raw in the JSON (marked `valid: false`).

## Aggregate (valid pairs only)

| comparison | pairs | candidate wins | control (A) wins | TIE |
|---|---|---|---|---|
| **B vs A** | 8 | **6** (H7, H10, H11, H13, H15, H27) | 1 (H2) | 1 (H1) |
| **C vs A** | 4 | 0 | 1 (H13) | 3 (H10, H11, H15) |

Reading: where both shipped, the endPass/data-verify arm (B) reads as a design
improvement over production defaults (6W-1L-1T) — consistent with data-verify's
relabeling making tiles/periods more truthful and pages tidier. The exemplar-contract
arm (C) shipped too few apps to say anything (0W-1L-3T on 4 pairs); its design signal is
dominated by the refusal wall, not by the contract's visual taste.

Statistical caveat: 8 and 4 pairs are far below the 40-pair basis of the 2026-07-21
pairwise; treat these as directional only.
