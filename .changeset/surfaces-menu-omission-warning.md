---
"@vendoai/actions": patch
---

An authored `surfaces.*` menu now says something when it leaves out a tool you
registered in code. `.vendo/overrides.json` is written against
`.vendo/tools.json`, and a `defineTool` tool is not in that file — it arrives
through `add()` at runtime — so a hand-authored `surfaces.mcp` list has no way
to mention it. The menu is a filter, so the tool was simply absent from the
door: registered, callable nowhere, and no signal that anything was wrong.

`surfaceMenu` now warns once per surface, naming each omitted tool and pointing
at the list to add it to. This is the mirror of the existing warning for menu
entries that match no registered tool. Curating away an EXTRACTED or connector
tool is what a menu is FOR and stays silent, and Vendo's own plumbing (the
`vendo_*` tools and the connector-discovery four) is exempt the same way the MCP
door and the agent projection already exempt it.
