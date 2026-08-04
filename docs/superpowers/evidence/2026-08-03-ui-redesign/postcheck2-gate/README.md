# Post-check round 2 — making the gate honest and the smoke tests discriminating

Branch `redesign/postcheck2-gate`, off `redesign/ui-s1` @ `d53f6a4b1`.
Binding: `/tmp/final-integration-ruling.md`, rulings 17b, 21 and 24.

**Ruling 21 is the standard everything here is held to**: a test that cannot fail
when its feature is reverted is not a test. So every claim below is a pair of
runs — the fix removed, then restored — recorded verbatim.

Everything ran LOCALLY (laptop, `packages/ui` vite harness on ephemeral ports).
No fleet machine, therefore no preview URLs.

## The reverting proofs

| Item | Proof | Reverted result |
|---|---|---|
| 1 — the §8 smoke test could not fail | `proof-1-m19-REVERTED.txt` / `proof-1-m19-RESTORED.txt` | deleting `chrome-css.ts:399-401` (the M19 suppression) makes it fail with `+ "fl-caret", "fl-skeleton-bar", "p::after", "table::after"` |
| 2 + 3 — nothing counted a poller request | `proof-2-poller-UNSHARED.txt` / `proof-2-poller-RESTORED.txt` | one feed per hook instance (pre-H15) makes the mount burst read **4** requests for 3 surfaces instead of **1** |
| 3 — the trace | `approvals-poller-trace.txt` | 13 requests over 60s for three surfaces; three pollers would be ~39 |
| 4 — the runner | `proof-4-runner-atomicity.txt` + `proof-4-runner-atomicity.sh` | all four behaviours, re-runnable in seconds |
| 5 — genui-bench ENOBUFS | `proof-5-enobufs-REVERTED.txt` / `proof-5-enobufs-RESTORED.txt` | Node's 1 MB default makes a 3 MB tracked diff throw `spawnSync git ENOBUFS` |
| 6 — CI coverage holes | `proof-6-center-a11y-REVERTED.txt` / `proof-6-center-a11y-RESTORED.txt` | removing H16's `enabled: seen` and H11's `inert` from `center/home.tsx` turns three `center-a11y` tests red (axe grows `color-contrast ×1`, H11 finds 0 of 3 previews inert, H16 finds no skeletons) |
| 7 — dev vs production harness | `proof-7-production-harness.md` | the checker's mechanism was wrong and the measurement is in there; the two red assertions were stale, not dev-mode artefacts |

## The gate runs

| File | What it is |
|---|---|
| `gate-1-GREEN-run-of-record.txt` | the first all-green run, four targets forced, 0 cached everywhere |
| `gate-2-FAILURE-PATH.txt` | one target broken on purpose: non-zero exit, a verdict naming it, the evidence tree untouched, failure logs elsewhere |
| `gate-3-GREEN-final.txt` | the run of record at the final tip, after the lint target was widened to all three legs of `pnpm lint` |

## Honest limits

- The per-test coverage table lives beside the specs at `packages/ui/e2e/README.md`.
  It names the findings that still have **no** browser test (C2, C5, H17) rather
  than implying the pack is complete.
- Four specs are RED on this branch on **product** defects owned by the defects
  worker, two of them inside the CI browser gate. They are listed in that README
  and nothing was quarantined to hide them.
- The 60-second poller measurement stays env-gated (`VENDO_POLLER_PROOF=1`). The
  CI gate is the ~20s request count, not the minute.
