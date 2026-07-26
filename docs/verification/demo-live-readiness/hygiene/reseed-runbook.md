# Hosted Cadence login reseed — runbook

One-paste repair for drifted demo credentials on the HOSTED Cadence Supabase
project. Prepared by the demo-hygiene lane; **executed by the conductor
against prod** — nothing in this file has been run against a hosted project.

## The fixed facts

The two seeded users are pinned in `apps/demo-accounting/src/server/users.ts`
(uuids MUST never change — offline JWT verification, actAs claims, and
`supabase/seed.sql` all key on them):

| User | Supabase `auth.users.id` | Email |
| --- | --- | --- |
| Maya Alvarez (primary) | `8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01` | `maya@cadence.test` |
| Daniel Hartwell | `3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02` | `daniel@cadence.test` |

The demo password's single source of truth is `cadenceDemoPassword()`
(`apps/demo-accounting/src/server/users.ts`): `CADENCE_DEMO_PASSWORD` if the
deployment sets it, else `cadence-demo`. Reseed to whatever that resolves to
for the hosted deployment — if the deployed app has `CADENCE_DEMO_PASSWORD`
set, use THAT value below, not the default.

## Option A — GoTrue admin call (preferred; no direct DB access)

Needs: the hosted project's URL and its **service_role** key (Supabase
dashboard → Project Settings → API). The service_role key never ships in any
app env; use it only from the operator shell.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SERVICE_ROLE="<service_role key>"
export DEMO_PASSWORD="cadence-demo"   # or the deployment's CADENCE_DEMO_PASSWORD

for id in 8d0158a1-bf6c-4e32-9dc4-8b17c1e14a01 3d2f5e0c-9b1a-4c8d-8e4f-2a6b7c9d1e02; do
  curl -sf -X PUT "$SUPABASE_URL/auth/v1/admin/users/$id" \
    -H "apikey: $SERVICE_ROLE" \
    -H "Authorization: Bearer $SERVICE_ROLE" \
    -H "Content-Type: application/json" \
    -d "{\"password\": \"$DEMO_PASSWORD\"}" | head -c 200; echo
done
```

Each call answers 200 with the user object. 404 means the user row itself is
missing — fall through to Option B, which recreates rows.

## Option B — service-role SQL (repairs OR recreates)

Needs: the project's Postgres connection string (dashboard → Project
Settings → Database; or `supabase db remote`). Apply the CONVERGENT seed —
since demo-hygiene T3 it upserts, so it both repairs drifted rows and
recreates missing ones:

```bash
psql "$DATABASE_URL" -f apps/demo-accounting/supabase/seed.sql
```

Note: the seed hashes the DEFAULT password (`cadence-demo`). If the hosted
deployment sets `CADENCE_DEMO_PASSWORD` to something else, follow the seed
with Option A's password calls (or an UPDATE using
`extensions.crypt('<password>', extensions.gen_salt('bf'))`).

## Deployed-app env these credentials depend on

From `apps/demo-accounting/src/server/users.ts:70-88` — in production both
are REQUIRED (the app throws without them):

- `SUPABASE_JWT_SECRET` — the project's legacy JWT secret (dashboard → API →
  JWT settings). GoTrue signs HS256 access tokens with it; the proxy/session
  verifier checks offline against it; away execution mints actAs JWTs with it.
- `SUPABASE_ANON_KEY` — the anon/publishable key the login route presents to
  GoTrue's password grant.
- `SUPABASE_URL` — the hosted project URL (defaults to the local stack when
  unset, which is never right in prod).
- `CADENCE_DEMO_PASSWORD` — only if the hosted seed diverges from the
  `cadence-demo` default; whatever is reseeded above must match it.

## Verify (the T5 canary, one shot)

```bash
CADENCE_CANARY=1 \
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_ANON_KEY="<anon key>" \
CADENCE_DEMO_PASSWORD="<only if the deployment overrides it>" \
pnpm --filter demo-accounting exec vitest run src/vendo/login-canary.test.ts
```

Green (2 passed) = both seeded logins work and resolve to the pinned user
ids. Red names the drifted user and the GoTrue verdict.
