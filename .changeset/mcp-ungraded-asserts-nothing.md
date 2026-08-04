---
"@vendoai/mcp": patch
---

The MCP door no longer tells a client a tool is non-destructive when nobody has
graded it.

Every listing carried `readOnlyHint` and `destructiveHint` derived from the
tool's risk label, and `ungraded` fell through to the same pair a `write` gets:
`readOnlyHint: false`, `destructiveHint: false`. MCP's own default for
`destructiveHint` is **`true`** — absent means "assume destructive" — so
emitting `false` was not a neutral value, it was an active claim of safety about
a tool no human, no judge, and no protocol fact had ever judged. That is exactly
the guess the risk-grading redesign deleted everywhere else, still being made on
the wire.

An `ungraded` tool now asserts neither hint. They are omitted, and the client
falls back to the spec's own conservative defaults. `destructiveHint: true`
would have been the opposite guess and just as unfounded; `readOnlyHint: false`
claims "this modifies its environment", which is equally unknown. The door says
nothing it cannot support, and `title` still rides along. Grade the tool
(`vendo sync`, the judge, or `.vendo/overrides.json`) and the hints come back.

`read`, `write`, and `destructive` listings are byte-for-byte unchanged. Both
surfaces that build MCP tools — the OAuth listing an outside agent sees and the
live-turn listing a `claudeCode()` box reads — share the one helper, so they
cannot drift.
