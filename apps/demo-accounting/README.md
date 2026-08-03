# Cadence

Cadence is the Vendo practice-management demo for client onboarding,
tax-document collection, filing deadlines, and client messaging.

## Setup

```bash
cd apps/demo-accounting
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY. COMPOSIO_API_KEY enables Gmail and Calendar.
supabase start   # real login — Supabase local (Docker + the Supabase CLI)
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the host API suite.

## Authentication (Supabase local)

Cadence uses real Supabase Auth. `supabase start` (from this directory; needs
Docker and the [Supabase CLI](https://supabase.com/docs/guides/local-development))
boots the local stack and seeds two demo users from `supabase/seed.sql`:

| Email               | Password       | User                     |
| ------------------- | -------------- | ------------------------ |
| `maya@cadence.test` | `cadence-demo` | Maya Alvarez (primary)   |
| `daniel@cadence.test` | `cadence-demo` | Daniel Hartwell          |

The password's single source of truth is `cadenceDemoPassword()` in
`src/server/users.ts` (`CADENCE_DEMO_PASSWORD` overrides it); the seed and
this table must match its default. Re-applying the seed converges a drifted
row back to these credentials.

Every page and firm API route requires a session (`src/proxy.ts`): pages
bounce to `/login`, APIs answer 401. The login form posts to GoTrue's real
password grant; the resulting Supabase access token becomes the session
cookie, named `sb-cadence-auth-token` per Supabase's own `sb-<ref>-auth-token`
convention. Verification is hybrid (`src/server/session.ts`): ES256 login
tokens verify against GoTrue's JWKS, HS256 tokens verify offline against the
project JWT secret. No env vars are needed locally — the app defaults to the
well-known `supabase start` URL, anon key, and JWT secret.

The Supabase session is the identity for everything, wired with one config
key — `auth: cadenceAuth` (the shipped `supabase()` preset, configured in
`src/vendo/auth.ts`): the Vendo principal is the Supabase user id, the MCP
OAuth adapter resolves the same session, and away execution needs no live
session at all — the preset's actAs half mints a real Supabase user JWT for
the granting user with the project JWT secret. `src/vendo/away-drill.test.ts`
proves it end to end (and runs without the Supabase stack — only login needs
GoTrue; `src/vendo/login-e2e.test.ts` covers that and skips itself cleanly
when the stack is down).

## Scripted demo automations

`src/demo-script/` seeds three automations for every seeded user at server
boot (`instrumentation.ts`) and again after `/api/demo/reset`, insert-if-absent
so a recorded edit is never clobbered. They exist to demo `rehearse()`, whose
payoff is the write path — reads execute for real under the guard's rehearsal
venue while write/destructive tools never reach the registry and resolve to a
simulated card carrying the fully resolved arguments. So the set spans the
risk ladder:

| Automation | Schedule | Shape |
| ---------- | -------- | ----- |
| Monday deadline digest | Mondays 08:00 | reads only — the control case |
| Verify pending uploads | Tuesdays 09:00 | read -> **write** (`host_setDocumentStatus`) |
| Friday document chase | Fridays 17:00 | read -> **destructive** (`host_sendClientMessage`) |

All three are seeded disabled: rehearsal is the pre-enable confidence step.
Weekly crons keep a 30-day replay at ~4 firings, well under the engine's
30-firing cap. The documents live in `src/demo-script/automations.ts`, free of
the Vendo server composition so they stay cheap to assert on; `seed.ts` owns
only the store write.

## As-of reads

`host_listDeadlines`, `host_listClientDocuments`, and `host_listActivity`
accept string `from`/`to` bounds. That is what makes rehearsal honest: the
engine pins each firing's window onto any read whose input schema declares
both (`acceptsDateBounds`), so a replayed firing sees the firm as it stood at
its own scheduled time instead of today — without them, every firing queries
current data and the timeline looks like history but isn't.

The projection lives in `src/server/asof.ts` and rolls back **only** the one
transition Cadence timestamps, the upload (`file.uploadedAt`):

- `uploadedAt > to` — the document was still `missing` then; file and note drop
- otherwise — left exactly as it stands today

Verification and rejection carry no timestamp, and the seeded activity feed is
texture rather than an event log, so a document's verified/rejected state is
always the current one even in a projected view. The tool descriptions say so,
so the model never claims a past verification date. `host_listActivity` is the
exception: every event carries its own `at`, so its window is an exact filter,
not a projection.

## Architecture

Cadence's product pages and seeded data remain self-contained under
`src/app`, `src/components`, and `src/server`. Vendo is composed once in
`src/vendo/server.ts` with the host model, the `auth: supabase()` identity
preset, the deployed policy, optional Vendo Auto judge, and Gmail/Google
Calendar Composio connector.

The umbrella is mounted by the single catch-all route at
`/api/vendo/[...vendo]`. React surfaces use the umbrella `VendoRoot`, UI
chrome, Cadence's registered status/progress components, and the frozen theme
in `.vendo/theme.json`.

The committed `.vendo/` directory contains the frozen tools, overrides,
policy, brief, and theme documents. `vendo sync` runs before development and
production builds.

Cmd/Ctrl+K opens Vendo outside the full assistant page. Cmd/Ctrl+Shift+.
restores Cadence's deterministic product seed.
