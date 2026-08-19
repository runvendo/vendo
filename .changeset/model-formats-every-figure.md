---
"@vendoai/apps": minor
"@vendoai/ui": minor
---

The model formats every figure now — the chart `format`/`xFormat` tokens are
gone, replaced by per-row formatter functions (`format={(row) => money(row.amount)}`),
resolved in the screen VM like every other per-row slot; axis ticks keep plain
digit grouping and never claim a unit. Timeline shows its time field as handed.
`info` is a real theme color, host-settable and derived from the accent where
unset — the Kit's hardcoded blue is gone. SegmentedControl speaks radio
semantics (`role=radiogroup`, `aria-checked`), so its live segment is readable
as selected rather than dead. The writer's manual teaches the Kit's real
handler shapes, verbatim ids, and always-pressable ask verbs; the reviewer
writes its reasoning before its verdict, so a finding can no longer contradict
itself into a wasted repair round.
