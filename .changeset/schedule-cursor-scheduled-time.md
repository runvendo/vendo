---
"@vendoai/automations": patch
---

An interval schedule's cursor advances by the window that came DUE, not by the
clock the tick happened to read. `packages/automations/src/ingestion-surface.ts`
wrote `lastFiredAt = atIso` — an observed instant, read after `ready()`, auth and
a store round trip — so every fire re-anchored the NEXT window to itself and
added its own second-or-so of latency to the one behind it. Any interval that is
a multiple of the heartbeat period then walked out of phase until a window landed
just under due and slipped a whole cycle: `{ every: "1m" }` under a once-a-minute
heartbeat fired every OTHER minute against Vendo Cloud (observed gaps 2m, 2m, 2m,
1m). An `every` now advances by whole windows from the last scheduled fire.

Cron is untouched, because a cron cursor cannot drift this way: croner re-anchors
to the pattern's own grid, and an observed time always sits in the same gap
between occurrences as the window it fired, so it reads identically to that
window forever. Collapse is unchanged — a backlog of missed windows is still
exactly one run on the most recent window, never back-filled or rapid-fired to
catch up — as are the compare-and-swap claim and the `at` one-shot. The cursor row
keeps its shape, so rows in the wild carrying an observed timestamp are read as
before and land back on phase on their first fire.
