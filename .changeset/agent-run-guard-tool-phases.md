---
"@vendoai/harnesses": patch
---

`agent_run`'s `guardMs` and `toolsMs` now carry real numbers. The breakdown
shipped with both hardcoded to `0` because the tool bridge — the one place that
stands in front of the guard's evaluation and the tool's own run — had no way to
reach the turn's collector, so a turn whose nine seconds went into a judge and a
slow host tool reported them as thinking time. The bridge now takes the same
`TurnTimings` the runtime already holds and marks the two phases it owns, summed
over the turn's calls. They are disjoint — the preview decides, the dispatch runs
on that verdict — so neither is counted into the other and `modelMs`, which is
whatever the other four leave over, stays honest. Durations only: a mark says how
long the guard took to decide and how long the tool took to run, never what was
called, argued or judged.
