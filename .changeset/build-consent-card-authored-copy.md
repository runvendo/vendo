---
"@vendoai/core": patch
"@vendoai/ui": patch
"@vendoai/apps": patch
---

fix: the build consent card says what a build actually does. Ruling 14 keeps a descriptor's description off the consent ladder, so the authored build sentence never reached the card and a person approving a build machine read the generic "This changes something in your account, and it runs as you." The copy Vendo writes by hand for its own tools now lives beside `VENDO_TOOL_TITLES` as `VENDO_TOOL_NOTES`, which the ladder reads under the host's own `ToolMeta.description` — so the card and the words-only surfaces (`BUILD_CONSENT_ASK`) say one thing, and nothing extracted can reach that rung.
