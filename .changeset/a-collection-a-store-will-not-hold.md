---
"@vendoai/core": patch
"@vendoai/apps": patch
"@vendoai/vendo": patch
"@vendoai/harnesses": patch
---

A store that will not hold one collection no longer takes the whole deployment down with it.

0.27.0 on a Vendo Cloud key served 501 to every route. The hosted store's engine allowlist did not carry two of the collections this version reads — `vendo_automations` and `vendo_app_seen` — and the automations one is read at BOOT, by the code-automations reconcile that rides the `ready()` latch. The latch memoizes, so the first refusal became every route's answer for the life of the process: 2.3 seconds for the first request, 3 milliseconds for every one after, all of them 501, including the routes that never touch an automation.

Three separate faults, and the deployment needed all three fixed:

The boot reconcile is no longer the deployment. A store that refuses the automations read leaves code-authored automations off and says so once, in a line the operator can act on; everything else serves. Scoped to that one read — every per-request store failure still fails in the open, where the caller can see it.

The unseen dot costs the dot, never the answer. `vendo_app_seen` was read on the path that LISTS a person's apps and written on every render, so a store refusing that collection took the whole page of apps with it. A refusal is absorbed there now, once per process, and the apps arrive without their arrival dots.

And `instanceof VendoError` does not survive a realm boundary. A host bundle can carry two copies of `@vendoai/core` — the ESM `dist/` beside the CJS `dist/cjs/` — and the second copy's VendoErrors are a different class with the same shape, so every `instanceof` gate said no. That is why a blocked collection reached the wire's catch-all as an unknown fault and answered "Internal Vendo error" instead of its own 403. `isVendoError` is the check that survives it (name + code, the two things a caller reads), and the wire's two catch-alls, the screen agent's no-row demotion, the tool pack and the harness tool bridge all use it — `@vendoai/harnesses`'s own copy of the duck check, which is where the pattern was proven, is now that one function.
