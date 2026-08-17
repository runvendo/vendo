---
"@vendoai/apps": patch
"@vendoai/ui": patch
---

A polled resource that keeps failing now backs off instead of holding its
cadence. `useResource` re-armed the next poll at the same interval whatever came
back, so a wire saying "no" was asked again at exactly the rate it was refusing:
an idle host produced 75 rate-limited calls in eight minutes, because the connect
dock's badge polls every 3s and the overlay keeps it mounted whether or not
anyone opens the panel. Consecutive failures now double the interval — jittered
so the several pollers one page mounts stop re-colliding, capped at a minute, and
reset by the first success. Every hook that takes `pollMs` inherits it; the fix
is in the one place they all share.

`@vendoai/ui`'s entry points carry `"use client"`. Only the umbrella's
`@vendoai/vendo/react` had it, so a host importing `@vendoai/ui`,
`@vendoai/ui/chrome`, `/kit` or `/tree` straight into a Next App Router tree got
the hooks as server code. All four are client boundaries now, which meant
retiring `export *` from three of them: Next's flight loader builds its
client-reference manifest by statically enumerating a client module's named
exports and errors outright on a star. The exported surface is unchanged, name
for name.

`@vendoai/apps`'s optional `typescript` peer widens from the exact `6.0.3` to
`>=5.6.0 <7`. That pin is the provenance of the `/edge` toolchain's vendored
compiler bytes, not a claim on the host's own compiler, and it printed a peer
warning on every stock install. The exact version the edge toolchain wants is
`EDGE_TYPESCRIPT_VERSION`, now stated on the edge-runtimes page.
