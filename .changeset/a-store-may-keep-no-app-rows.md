---
"@vendoai/core": patch
"@vendoai/apps": patch
"@vendoai/store": patch
"@vendoai/vendo": patch
---

`StoreOps.appData` is OPTIONAL, on the same rule the other four optional members
already follow: a store with nowhere to keep app rows says so by OMITTING the
family, rather than shipping a stub that accepts the call and does something
else. A store that omits it is refused at the door onto app rows — `/box/rows`
answers the `not-implemented` refusal it already gave a store with no
named-operation surface at all — and the app-storage backing falls through to
the same façade path that store already took.

Nothing changes for the stores this repo ships: `createStoreOps` (the local
backend) and `hostedStoreOps` (the Cloud client) both serve the family, and both
now say so in their return type, `StoreOpsWithAppData`. The StoreOps conformance
kit reports its appData cases as OMITTED for a mount without the family instead
of crashing on the first verb.
