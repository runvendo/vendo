---
"@vendoai/vendo": patch
---

A supabase() host learns about its server-side env before the first signed-in
turn fails. Init's detection now attaches an advisory when it wires the
Supabase family and neither `SUPABASE_JWT_SECRET` nor `SUPABASE_URL` is in the
process env or any host env file — the preset verifies sessions with those
server-side names, not the `NEXT_PUBLIC_*` pair detection saw. Doctor gains
the matching static check, E-AUTH-009 (a warning: production-only env is
legitimate), built on the same shared helper so init and doctor can never
disagree.
