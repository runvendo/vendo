---
"@vendoai/vendo": patch
---

An alias-wired host reads as wired. The wiring scan's server marker knew only
the scoped `@vendoai/vendo/server` spelling, so a host importing `createVendo`
through the unscoped `vendoai` alias was diagnosed "not wired" (E-WIRE-001 /
E-WIRE-007) by doctor and init alike — and a `VendoRoot` import from the alias
dodged the E-WIRE-010 legacy warning the same way. Both markers now read both
supported spellings, like the supabase preset marker before them.
