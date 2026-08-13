---
"@vendoai/core": patch
"@vendoai/guard": patch
"@vendoai/automations": patch
---

Arming asks become visible on every StoreAdapter. The automations arming capture wrote its approval rows to `vendo_approvals` without the `subject`/`status`/`call` refs the guard's ref-filtered feeds query by — repo-shipped stores masked it (the reserved table derives those refs from the row itself), but a generic or cloud-hosted records store honors exactly what a writer passes, so the asks were counted by `pendingGrants` yet invisible to `GET /approvals` and immune to the guard's abandoned-ask sweep: an automation card "waiting on N permissions" with nothing to decide, forever. Core now exports `approvalRecordRefs` as the one refs contract for the collection's writers; the guard's park delegates to it; the automations capture stamps it on mint, keeps it across the consume flip, and re-stamps it when arming adopts a pre-contract pending ask — so re-enabling an automation heals rows minted before the fix.
