---
"@vendoai/vendo": patch
---

`vendo sync --ai` on an incremental run now reaches an engine on Claude Code's own-credential env vars (`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, a custom `ANTHROPIC_BASE_URL`), which both Claude harnesses already accept. That one flag combination is the only path that falls back to the runtime credential resolver instead of sweeping the harness ladder, so it alone reported "no model credential" while `vendo init` and an interactive `vendo sync` ran fine on the same login. The runtime resolver itself is unchanged — product turns still require a real API key.
