---
"@vendoai/core": minor
---

`AppDocument.server` — the retired v1 snapshot ref — is removed from the schema.
Its last readers went with the tier-4 deletion in `@vendoai/apps`, and a
production audit of all 84 Cloud tenant schemas and the console mirror (898 app
documents) found zero documents carrying it, so the field dies wholly rather
than lingering as a declaration nothing reads.

Two validation rules move with it:

- the fn:-presence rule no longer accepts `server` as a substitute for a box —
  its message is now `fn: references require a machine`
- the `server` reference-format check is gone; `machine.snapshotRef` keeps the
  same `SERVER_REFERENCE_PATTERN` check it always had

The shape schema is `.passthrough()`, so a stored document that still carries a
`server` key parses exactly as before — the key survives as an unknown field and
is simply no longer typed or validated. The one behavior change: a document with
`fn:` references, a `server` and no `machine` used to validate and now does not.
