---
"@vendoai/apps": patch
---

An edit that did not save says so, and the format reference stops denying `<Plan display>`.

A refused save degrades rather than throws — the app is on screen, it just is not in the
store — and the assembler sits between that save and `edit()`, so the refusal had nowhere
to go: `assembleEdit` re-read the row, found the PRE-edit document, and handed it back with
no `failure`. An agent read that as done and the person's ask was silently lost. The save
now records why it did not land, keyed by app and matched on the person's own words (the
return leg `editIntents` already had), and the edit fails with that reason instead. The
live trigger is a write-only refusal — chiefly the `assertCurrent` conflict when a skill's
timer-save races an edit; a whole-store outage already self-reported through the read.

The `.vendo` format reference promised it was taken from the parsers and then stated flatly
that no `<Plan>` attribute but `name` is read, while `compilePlan` reads `display` and the
`building-apps` skill on the same mount teaches `display="stage"` as load-bearing. A model
that trusted the reference stripped it, and the app arrived as an inline card instead of a
full-width stage. `display` is documented now, and the reference's own suite scans the
compiler for the attributes it reads, so the next one fails the build until it is written
down.
