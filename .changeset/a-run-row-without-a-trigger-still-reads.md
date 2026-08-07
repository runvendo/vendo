---
"@vendoai/automations": patch
---

A run row that names no trigger reads back under the default trigger.

Making an app's triggers a LIST added a required `triggerId` to the persisted
run record with no read fallback, so every row written before that made
`runs.list` throw `validation` for the whole app — the surface asking for one
automation's history got a 400 instead of a gap, and one legacy row took the
app's entire fire record down with it. The field now defaults to
`DEFAULT_TRIGGER_ID` on read, exactly as the capture row's `triggerId` beside
it already did: a row written when an app had one trigger fired that trigger.

Nothing changes for rows written since. Nothing is rewritten on disk; the
default applies on read.
