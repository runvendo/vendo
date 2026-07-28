---
"@vendoai/vendo": patch
---

Remix is experimental: unresolved remixable slots now warn (`experimental:` prefix, slot + reason + fix hint) instead of failing `vendo sync` with exit 2. Slots are still never skipped silently; acknowledge intentionally uncapturable ones in `overrides.json` → `remix.ignoreSlots`.
