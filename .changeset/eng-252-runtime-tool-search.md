---
"@vendoai/actions": minor
"@vendoai/agent": minor
"@vendoai/vendo": minor
---

Runtime tool search and loadout (ENG-252). Add a deterministic `ActionsRegistry.search` query API (plus the pure `searchToolDescriptors`) that ranks the merged, enabled tool surface by intent, excluding disabled tools. The agent gains a `vendo_tools_search` meta-tool: it starts from a bounded initial loadout — the whole enabled surface when it fits the cap, an explicit curated list when provided, otherwise a read-first bounded default (`DEFAULT_MAX_INITIAL_TOOLS`) — and discovers and loads the rest mid-run. Loaded tools persist across turns within a thread and execute through the same guard-bound registry as any initially-enabled tool, so there is no unguarded path. The umbrella wires the search seam to the guard-bound registry.
