---
"@vendoai/vendo": patch
---

The plain-http anonymous-session cookie is now `Path=/`, matching the secure
`__Host-` form (#693). The cold-load race fix has hosts mint the pointer on
their document response, mint-unless-present — but a `Path=/api/vendo` cookie
never rides a document/page request, so on plain-http localhost such a host
re-minted on every page load and status poll, overwriting the cookie's one jar
slot and moving the visitor onto a fresh `anonymous_<id>` subject: list
endpoints answered `[]` and the second message on any thread failed with
`threadId is already in use`. https was never affected because `__Host-`
requires `Path=/`. Existing `Path=/api/vendo` cookies keep working — the wire
reads the pointer by name and honors it as-is.
