---
"@vendoai/apps": patch
"@vendoai/vendo": patch
---

Two fixes from the first full init→app-generated e2e on real workerd:
the island TSX validator's esbuild import is now bundler-blind (Wrangler
inlined the Node-only package into Worker bundles, where its __filename
crash was misread as "invalid TSX" and failed EVERY app build — the field
report's apps-create death), and a validator that crashes at runtime now
degrades to no validation instead of failing every island. The CLI also
accepts `--framework custom` (the flag whitelist had missed it; only the
programmatic path worked).
