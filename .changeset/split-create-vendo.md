---
"@vendoai/vendo": patch
---

Decompose `createVendo` into one module per composition phase. Pure refactor:
the public surface of `@vendoai/vendo` and `@vendoai/vendo/server` is unchanged
— every type and value the entry exported is still exported from it, and no
importer outside the package changes.
