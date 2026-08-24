---
"@vendoai/harnesses": minor
---

The shell can write and run JavaScript.

`bash` now carries `js-exec`: the agent writes a script and runs it in a QuickJS
sandbox on a worker thread — 64 MiB, 30 seconds, no network — with
`require("node:fs")` bound to the SAME virtual workspace bash sees. That is the
difference between "reshape this spreadsheet" being a page of `awk` and being
five lines of the language the model writes best.

It is a capability, not a flag: on a runtime with no `node:worker_threads` (edge,
Workers) the shell is still the whole shell — bash, the coreutils, the parsers —
and the tool simply does not advertise `js-exec` to the model.
