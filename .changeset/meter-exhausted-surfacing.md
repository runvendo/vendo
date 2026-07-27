---
"@vendoai/core": minor
"@vendoai/agent": patch
"@vendoai/vendo": patch
---

Vendo Cloud meter refusals (pricing v3 §5: HTTP 402, stable code
`meter-exhausted`, structured body) now surface honestly everywhere the OSS
client can meet them — with no client-side entitlement checks; the refusal
body stays the only source of truth. Core gains `parseMeterExhausted` /
`formatMeterExhausted` / `meterExhaustedFromError`: one crafted sentence
naming the meter, the usage figures and reset date, and the two exits
(upgrade / BYO). The Cloud adapters (hosted store, sandbox, connections,
apps) render that sentence on their existing 402 → cloud-required mapping
with the structured fields preserved on `detail`; the agent recognizes the
gateway's 402 refusal on the safe stream-error rail so the thread banner
ends the turn with it; the CLI prints the same single line instead of a raw
error dump, and doctor's existing live-turn check surfaces safe
Vendo-prefixed error frames verbatim. Scheduler-refused automation runs
already read back as failed runs — the blocked reason and code now have
test-pinned rendering in run history.
