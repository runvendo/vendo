---
"@vendoai/apps": patch
---

A create whose document generated cleanly no longer loses the whole turn when the store refuses to persist it. The final view part was emitted *after* `apps.put`, so a rejected write took the settling emit with it: every streamed card froze on whatever mid-stream payload it last held (a half-painted chart, an empty-state table) with no way to tell a frozen card from a genuinely empty one, the create tool answered the agent with a bare error, and the agent apologized and rebuilt the same app twice more — three cards for one prompt, none of them saved, nothing logged on the user path. Live on the deployed Maple demo, whose Cloud store was rejecting every `vendo_apps` write.

Now the finished view is emitted before anything that can fail, a failed persist degrades the app to view-only instead of discarding it, and the failure is named in the operator log (`app not saved (<id>): the view rendered but the store rejected it`, plus `(NOT SAVED)` on the completion line) and handed to the agent as an `unsaved` note on an `ok` result — so it states the one true thing and stops, instead of apologizing for a view the user can see. Escalation is skipped for an unsaved app, since every rung writes through the same store. Separately, a query that resolves non-ok now warns once instead of silently rendering an empty card.
