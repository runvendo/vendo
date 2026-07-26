---
"@vendoai/core": minor
"@vendoai/actions": minor
"@vendoai/mcp": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

Make the MCP door presentable: per-surface tool menus, human tool titles, and
risk-derived MCP annotations.

Hosts curate what each surface offers from `.vendo/overrides.json`'s new
`surfaces` block (`agent` and `mcp`, a closed key set so a misspelled surface
fails loudly at parse). `ActionsRegistry.surfaceMenu()` resolves it: the
authored list wins, an absent `agent` menu is unrestricted, and an absent `mcp`
menu falls back to every merged, enabled tool whose `audience` is `end-user` or
unset. Menus are curation, not security: the guard, `disabled`, and audience
exclusions are untouched, an off-menu call returns the same not-found an unknown
tool returns, and a menu entry naming a missing or disabled tool warns once and
is skipped rather than taking the host down. Vendo's own `vendo_*` runtime tools
are never curated away on either surface.

`ToolDescriptor` and `ToolOverride` gain an optional `title`: the short human
label for surfaces people read. `vendo sync`'s AI enrichment proposes one per
tool (presentation, so it is exempt from the restrictive-only clamp and carried
across structural syncs); `.vendo/overrides.json` corrects it. The door emits it
in both standard MCP places (top-level `title` and `annotations.title`), and
approval cards prefer it over the prettified tool id, behind an in-code
`ToolMeta.label`.

**Upgrade note.** Every tool the door lists now carries `annotations`
unconditionally, including for hosts with no `surfaces` block. That means a
`read` tool asserts `readOnlyHint: true` to clients, and some MCP clients use
that hint to skip their own confirmation prompt for read calls. Nothing changes
server-side: Vendo's guard, policy, approvals, and audit decide exactly what
they decided before, and annotations are hints the spec says clients may
ignore. If you have a `read`-labelled tool that is not actually side-effect
free, correct its `risk` in `.vendo/overrides.json` — that label was already
driving your policy.

Every tool the door lists now also carries `annotations` derived from its risk
label (`read` → `readOnlyHint`, `destructive` → `destructiveHint`), and the door
serves a themed, script-free, unauthenticated connect page at `{mount}/connect`
with the MCP URL and per-client setup steps for Claude, ChatGPT, and Cursor.
demo-bank ships a curated twelve-tool menu as the worked example.
