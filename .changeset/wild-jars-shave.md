---
"@vendoai/vendo": minor
---

Delete `@vendoai/engine`; init's `--engine npx` rung now fetches Anthropic's
published `@anthropic-ai/claude-code` instead.

The rung's user-facing behaviour is unchanged — last resort, one-time ~250MB
`npm exec` fetch disclosed before it starts, read-only Read/Glob/Grep over the
host root, own credential or the Vendo Cloud gateway — but it now spawns the
same binary as the PATH rung rather than a Vendo-published wrapper around the
Agent SDK. The credential label reads "via npm-fetched Claude Code" instead of
"via the Vendo engine".

The engine's path-confinement guard moves up to the ladder level
(`cli/extract/confine-to-root.ts`) and is wired into the Agent SDK rung as its
`canUseTool` callback, so a prompt-injected `Read ~/.aws/credentials` is denied
there too. That rung now passes `tools` rather than `allowedTools`, because a
blanket allowlist auto-allows and never consults the callback.
