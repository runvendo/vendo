---
"@vendoai/store": patch
---

The PGlite boot retry now knows all four faces of a half-written install.
`could not load library "/pglite/lib/postgresql/plpgsql.so"` and initdb's
`input file ".../postgres.bki" does not belong to PostgreSQL 18.3` are the same
corrupt `@electric-sql/pglite` bundle that already produced `Invalid FS bundle
size` and `PGlite failed to initialize properly` — a `.so` that dlopen cannot
read and a leftover input file from another version, instead of a short read —
but neither matched, so they fell through with no recovery path. Between them
they killed six CI runs on 2026-08-19, each on a different random test in
`packages/agents`.

All four share the one delayed retry. The library signature is pinned to the
bundle's own `/pglite/…` path, so a host extension that fails to load still
raises on the first attempt.
