---
"@vendoai/actions": patch
"@vendoai/vendo": patch
---

Doctor judges unknown-framework hosts (Cloudflare Workers, Bun, Hono, ...)
by their actual wiring instead of Next.js file layout — no more permanent
E-WIRE-003/004 false positives on custom runtimes (new codes E-WIRE-007/008).
The tool surface is now graded statically: all extracted tools disabled or
excluded fails doctor (E-TOOLS-001), an empty surface warns (E-TOOLS-002),
and the actions registry warns at runtime when the agent composes with zero
live host tools — the silently-useless-agent failure mode is no longer
silent anywhere.
