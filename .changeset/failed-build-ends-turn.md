---
"@vendoai/core": patch
"@vendoai/agent": patch
"@vendoai/apps": patch
"@vendoai/ui": patch
---

A chat turn whose app build terminally fails now ENDS, with the classified
failure reason visible in the thread. Before, the failed build came back as a
plain error outcome only the model could see: the tray rendered nothing, and
the model re-ran the minutes-long doomed build inside the same turn until the
step cap — a thread stuck "streaming" for 10+ minutes with no banner and no
reason (0.4.4 E2E cert). The agent's tool bridge now streams an additive
`data-vendo-build-failed` part (toolCallId + the runtime's canned, non-leaky
reason) beside the failed `vendo_apps_create` result, the agent loop stops the
turn after the failed build (re-asking is the user's call, matching the BYO
embed's failed vocabulary), and the thread renders the part as an error beat
with the reason.

The generation engine also names an empty model stream as its own failure
class ("completed without any text output") instead of reporting the empty
string's wire-parse issues — the 0.4.4 cert's "wire missing-app / empty
layout" failures were a gateway alias ending turns reasoning-only, not a
model-format defect, and the old issue list mis-routed that triage.
