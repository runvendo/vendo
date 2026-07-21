---
"@vendoai/vendo": patch
---

Login and first-turn fixes from the 0.4.1 E2E certification campaign:
`vendo login` pending claims are now scoped per project directory —
concurrent logins in different repos can no longer clobber or resume each
other's ceremonies (the machine-global file could deliver one project's key
to another). A matching pre-0.4.2 claim file is migrated automatically.
`vendo init` now installs the model provider its resolved credential loads
at runtime (`ai@^6` plus `@ai-sdk/anthropic@^3` / `@ai-sdk/openai@^3` /
`@ai-sdk/google@^3`), so the first turn no longer 500s on a fresh install
until the provider is added by hand.
