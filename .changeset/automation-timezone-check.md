---
"@vendoai/vendo": patch
"vendoai": patch
---

An automation's `timezone` is checked when it is created, the way its cron already is. An unresolvable name such as `"America/New York"` was stored and armed, then threw inside the shared schedule tick, so every other schedule in the deployment stopped firing with it.
