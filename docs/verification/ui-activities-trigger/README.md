# Browser evidence: VendoActivities + VendoTrigger (PR #359)

Post-merge revalidation of the two Lane B shelf pieces, captured against
main (`780b6e2a`, after #359 merged). The originals referenced in PR #359's
body were silently dropped by the repo-wide `*.png` gitignore; these are
committed with `git add -f`.

| Beat | File |
| --- | --- |
| Maple `/vendo` — VendoActivities quiet empty state (fresh store) | `bank-activities-initial.png` |
| Approval raised in chat appears in the Activities queue (real inputs, write chip) above the humanized feed | `bank-activities-approval.png` |
| Decided in-place from the Activities card — queue section clears, feed shows the approved order running | `bank-activities-decided.png` |
| Cadence dashboard — "Nudge with AI" VendoTrigger in the header beside the missing-docs hero | `cadence-trigger-button.png` |
| Click → overlay opens with the chase prompt prefilled, not sent (0 turns) | `cadence-trigger-prefilled.png` |
