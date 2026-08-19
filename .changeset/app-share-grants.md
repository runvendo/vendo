---
"@vendoai/apps": minor
"@vendoai/vendo": minor
"@vendoai/ui": minor
---

An app can be shared again. `AppsRuntime.access` regains `list`, `grant` and
`revoke` (viewer-scoped read, owner-scoped writes, each write answering with the
resulting list), the wire mounts `GET /apps/:id/grants` and
`PUT|DELETE /apps/:id/grants/:principal`, and the client regains
`apps.grants/.share/.unshare`. The person picker and `promote` are deliberately
not back.
