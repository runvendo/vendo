# Wave 6a — Cadence captured demos (ENG-239, part 1 of 2)

Captured 2026-07-16 on the Cadence demo host (`apps/demo-accounting`), per the
Wave 6 section of `docs/superpowers/specs/2026-07-14-block-foundations-design.md`.
The Maple beats (provider-swap, resilience drills) are owned by a separate
worker. All captures are local: `next dev` on `localhost:3000`, a throwaway
Homebrew Postgres 18 cluster on port 54329, session minted offline (HS256
against the well-known `supabase start` JWT secret — no Supabase stack needed).

No source changes ship with this PR. The Postgres leg needed a two-line
uncommitted wire-up in `apps/demo-accounting/src/vendo/server.ts` (reverted
after capture; reproduction below) because the contract deliberately defines no
storage env-var alias — hosts pass `createStore({ url })` explicitly
(`docs-site/reference/environment-variables.mdx`).

## Beat A — Postgres-swap (`postgres-swap/`)

**What was captured**

1. **PGlite default** — `createVendo` with no store config writes to
   `.vendo/data`. `01-pglite-home.png` shows the Cadence dashboard logged in as
   Maya Alvarez; `02-pglite-vendo-chat.png` shows the Vendo panel completing a
   chase-list request with live `host_getDashboard` / `host_listDeadlines` tool
   calls on that default store. `04-pglite-store-sql.txt` lists the PGlite data
   dir and queries all 15 `vendo_*` tables through the store handle
   (`query-store.mjs`).
2. **Real Postgres** — the same host booted with
   `store: createStore({ url: process.env.POSTGRES_URL })`. On boot it created
   the full `vendo_*` schema in Postgres; `03-postgres-vendo-chat.png` shows the
   same conversation flow working against it.
3. **Host-side SQL** — `05-postgres-psql.txt` is a real `psql` transcript:
   `\dt`, the persisted `vendo_threads` row (subject = Maya's Supabase uuid),
   per-table row counts, audit rows — plus a restart-survival addendum (server
   stopped and rebooted on the same `POSTGRES_URL`; the host API lists the same
   thread).

**Reproduce**

```bash
# PGlite default
set -a; source <keys>.env; set +a          # ANTHROPIC_API_KEY
VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-accounting dev
# (VENDO_BASE_URL must be set: present credentials only forward to a TRUSTED base URL)

# Postgres swap: start any local Postgres, then add to src/vendo/server.ts:
#   import { createStore } from "@vendoai/store";
#   const postgresUrl = process.env.POSTGRES_URL;
#   createVendo({ ...(postgresUrl ? { store: createStore({ url: postgresUrl }) } : {}), ... })
POSTGRES_URL=postgres://vendo@127.0.0.1:54329/vendo_cadence \
  VENDO_BASE_URL=http://localhost:3000 pnpm --filter demo-accounting dev

# Host-side SQL (either backend), from apps/demo-accounting:
node ../../docs/verification/foundations-wave6/postgres-swap/query-store.mjs pglite .vendo/data
node ../../docs/verification/foundations-wave6/postgres-swap/query-store.mjs pg "$POSTGRES_URL"
psql "$POSTGRES_URL" -c '\dt'
```

**Files**: `01-pglite-home.png`, `02-pglite-vendo-chat.png`,
`03-postgres-vendo-chat.png`, `04-pglite-store-sql.txt`,
`05-postgres-psql.txt`, `query-store.mjs`.

**Finding (flagged for follow-up, not fixed here):** under `next dev`
(Turbopack), turns persisted through the composed stack were visible via the
host API but never reached the PGlite files on disk — nothing under
`.vendo/data` changed after boot, and threads did not survive a dev-server
restart. One `SIGTERM` mid-run also left the data dir unopenable (PGlite
`RuntimeError: Aborted()` on reopen). The identical flow on Postgres persists
durably and survives restarts (see `05-postgres-psql.txt`), and the store's own
SIGKILL durability drill (`packages/store/src/durability.drill.test.ts`) passes
in plain node — so this looks specific to the Next dev-server runtime (likely a
second in-process PGlite instance after HMR, or an unflushed WASM VFS), not to
the store. Worth a ticket; out of scope for a capture-only PR.

## Beat B — Encryption / retention proof (`encryption-retention/`)

**What was captured** — `01-encryption-retention-transcript.txt`, produced by
`encryption-retention-demo.mjs` against the same local Postgres the host used
(Maya's beat-A thread is visible in the erase counts):

1. **Ciphertext at rest** — two secrets written through
   `secretStore(store).set(...)` with a fresh 32-byte key; raw SQL shows only
   `v2:<iv>:<tag>:<ciphertext>` envelopes, the plaintext appears nowhere, and
   `storeSecrets(store).get(...)` decrypts correctly with the configured key.
   The external `psql` view at the end shows the same envelopes.
2. **AAD tamper rejection** — swapping one row's ciphertext into another row
   via raw SQL makes the read fail (`Stored secret could not be decrypted`):
   the v2 envelope binds the secret NAME as AES-GCM AAD, so a swapped
   ciphertext fails the auth tag instead of decrypting to the wrong secret.
   A direct bit-flip on the ciphertext is rejected the same way.
3. **Erase API** — two subjects seeded across `vendo_threads` and
   `vendo_grants`; `eraseStore(store).bySubject(...)` removes exactly the
   target subject's rows (report: `{"vendo_threads":2,"vendo_grants":1}`),
   before/after counts show the other subject's data intact.

**Reproduce** (from `apps/demo-accounting`, any Postgres URL):

```bash
WAVE6_ENC_KEY=$(openssl rand -base64 32) node \
  ../../docs/verification/foundations-wave6/encryption-retention/encryption-retention-demo.mjs \
  "postgres://vendo@127.0.0.1:54329/vendo_cadence"
```

**Files**: `01-encryption-retention-transcript.txt`,
`encryption-retention-demo.mjs`.

## Parked beats

None — all Cadence beats captured.
