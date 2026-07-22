---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

Extraction now grades every tool's audience (end-user / operator / internal)
by reading the handler's own auth checks, and excludes non-end-user tools
from the embedded agent by default (recorded as `audience` in
.vendo/overrides.json; human decisions always win). Applying a surface that
leaves the agent with zero live tools warns loudly instead of shipping a
silently useless agent. Field origin: an infra product's extraction proposed
operator/reconciliation endpoints; stripping them by hand left an empty
toolkit and an agent that couldn't act.
