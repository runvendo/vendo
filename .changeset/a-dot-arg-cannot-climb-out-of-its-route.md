---
"@vendoai/actions": patch
---

Security: a route tool argument of `.` or `..` can no longer climb above the
tool's declared path. `withPathArgs` substituted call args with
`encodeURIComponent`, which leaves dot-segments intact (and the array branch
joins with a raw `/`), so an arg like `id: ".."` or `id: ["..","..","admin"]`
resolved through `new URL` to escape the route (e.g. `/users/{id}` → `/admin`).
Args are never validated against `inputSchema` and are steerable by end-user
chat, so each substituted segment is now rejected with a `validation` error
before any request is made (#988).
