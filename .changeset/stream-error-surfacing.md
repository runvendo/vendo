---
"@vendoai/agent": patch
"@vendoai/ui": patch
---

Mid-stream turn errors are no longer a dead end: the agent logs the real
error server-side ("[vendo] turn stream error") and passes its OWN safe
errors (VendoError code + message) to the wire recognizably prefixed, while
raw provider/transport strings stay the fixed generic text. The thread
error banner renders that safe detail line (code included) next to Retry —
"Something went wrong" alone is now reserved for errors we genuinely can't
say more about.
