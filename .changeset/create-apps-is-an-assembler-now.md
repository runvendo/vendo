---
"@vendoai/apps": patch
---

`createApps` is an assembler now, not a 2,600-line function. Every private helper and every door it returned moved into a module beside its contract, each taking a `Pick` of the one shared closure type and returning its slice of `AppsRuntime` — the same shape the namespace surfaces already had. The public surface is unchanged: `@vendoai/apps` exports exactly what it exported, `runtime.ts` still re-exports every moved type and value, and no test changed. Pure refactor, no behaviour difference.
