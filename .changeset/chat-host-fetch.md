---
"@vendoai/ui": patch
---

`useVendoChat` takes a `fetch`, so a header-authenticated host can use it.

The hook called `globalThis.fetch` directly on all three of its routes — the
turn, the transcript read-back a reload does, and the approval decision on the
permission wire. That works when the session is a cookie, because the browser
attaches it without being asked. It cannot work when the session is a bearer
token: nothing in `UseVendoChatOptions` reached the request, so there was no
way to put an `Authorization` header on it, and every route answered 401.

`fetch` is now an option. Unset, it is `globalThis.fetch` and nothing changes.
Set, every request the conversation makes goes through it — which is the point:
a hook that authenticated the send but not the read-back would leave a host
with a conversation that half-works, and the half that fails is the one that
restores a parked approval after a reload.

It is read through a ref, so a token that changes between renders is picked up
on the next request rather than pinned by the transport's first build.
