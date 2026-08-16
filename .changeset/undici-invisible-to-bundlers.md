---
"@vendoai/vendo": patch
---

Next 14 hosts can compile the wire again: the keep-alive pool's dynamic
`import("undici")` now carries `webpackIgnore`, so bundlers leave it to the
runtime instead of parsing undici — whose syntax Next 14's webpack cannot
read — into every wire-route build. Runtime behavior is unchanged: Node loads
the pool as before, and targets without undici keep the plain-fetch fallback.
