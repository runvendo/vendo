---
"@vendoai/core": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Add `isVendoToolPart` to `@vendoai/vendo/react` — the guard the existing-agent quickstarts already document but no published build shipped. It answers "is this tool part Vendo's or mine?" for a BYO renderer, covering both shapes the AI SDK streams (`tool-<name>` and `dynamic-tool`, the latter being what Mastra emits for a tools-as-function agent), and narrows to the tool-part union so `part.state` and `part.output` typecheck without a cast. `isToolUIPart` from `ai` is not a substitute: it is true for every tool part, including the host's own. `VENDO_TOOL_PACK_PREFIX` moves to `@vendoai/core` so the pack that mints the names and the renderer that recognises them share one constant; `@vendoai/vendo/ai-sdk` and `/mastra` re-export it unchanged.
