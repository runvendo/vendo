---
"@vendoai/apps": minor
---

feat(apps): guarded per-secret in-sandbox exposure toggle (ENG-345)

Adds the off-by-default exception path to the Option B secrets gateway: an
owner-only, per-secret × per-app toggle that injects a secret's real value into
the sandbox env instead of a handle. Flipping it on is a high-risk action gated
by the guard's existing approval flow; every run with an exposed secret emits an
audit event; and the grant lives outside the app document so it never travels
with a share, remix, fork, export, or import (copies always revert to handles).
