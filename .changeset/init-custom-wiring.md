---
"@vendoai/vendo": patch
---

`vendo init --framework custom`: a runtime-neutral wiring for any
Web-standard host (Cloudflare Workers, Bun, Deno, Hono). The generated
vendo/server.ts is a lazy Request→Response module with the environment
passed per call; with a Vendo Cloud key it wires the Cloud adapters
explicitly (model = stock Anthropic provider at the console gateway).
Unknown-framework detection lands here instead of guessing the Next
layout into hosts that aren't Next.
