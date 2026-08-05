---
"@vendoai/vendo": patch
"@vendoai/actions": patch
---

Security floor for `@auth/core`: the optional peer range moves from `^0.34.3`
to `>=0.41.3`. The `authJs()` presets pass the raw incoming request to the
host's `getToken()`, and `@auth/core` versions before 0.41.3 have a
request-triggered CPU-exhaustion DoS in that call. 0.41.3 is the patched
release; hosts on older Auth.js should upgrade `@auth/core` alongside this.
