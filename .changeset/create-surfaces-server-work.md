---
"@vendoai/apps": patch
---

A create that rode its plan to an automation now surfaces the envelope instead of dropping it: `AppsRuntime.create` gains an additive `onServerWork` hook carrying what the server lane produced (the authored automation with its armed state and pending-grant count, arming/flip issues, and the failure sentences when required server work could not be built), and `vendo_make` publishes the same `data-vendo-automation` thread card for a first-ask automation that the edit path has published since Wave 9. Required server work that could not be built rides the receipt's `say` as an honest caveat instead of dying in the server log.
