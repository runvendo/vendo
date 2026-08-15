---
"@vendoai/core": patch
"@vendoai/store": patch
---

`STORE_WIRE_PATHS` now declares the erase door that actually exists. The manifest listed `lifecycle.erase` at `/lifecycle/erase` with a body that wrapped the scope in `{target: {...}}`, while every mount — the console included — serves `/erase` with the scope FLAT, and the hosted client sent it there by hardcoding the path rather than reading the table. The published contract therefore described a route no client calls and no service answers: anyone building a Store Wire v1 mount faithfully from `STORE_WIRE_PATHS` would never receive an erase, and would have validated the wrong body if one arrived. The manifest is now `/erase` with a flat `{subject}` / `{appId}` request schema (still exactly one of the two — a destructive call with no scope is still refused), and both hosted erase surfaces, the `StoreOps` client and the `StoreAdapter` façade, take their route from the table like the other 35 ops, so the two can no longer drift.

No behavior changes on the wire: the client sent `POST /erase` with a flat body before this change and sends the identical request after it. Only the contract the manifest publishes changed, to match what ships.
