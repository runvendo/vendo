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

Every page and firm API route requires a session (`src/proxy.ts`): pages
bounce to `/login`, APIs answer 401. The login form posts to GoTrue's real
password grant; the resulting Supabase access token becomes the
`cadence-session` cookie. Verification is hybrid (`src/server/session.ts`):
ES256 login tokens verify against GoTrue's JWKS, HS256 tokens verify offline
against the project JWT secret. No env vars are needed locally — the app
defaults to the well-known `supabase start` URL, anon key, and JWT secret.

Away execution needs no live session at all: `actAs` in `src/vendo/auth.ts`
mints a real Supabase user JWT for the granting user with the project JWT
secret via `@vendoai/actions/presets`. `src/vendo/away-drill.test.ts` proves
it end to end (and runs without the Supabase stack — only login needs GoTrue;
`src/vendo/login-e2e.test.ts` covers that and skips itself cleanly when the
stack is down).

## Architecture

Cadence's product pages and seeded data remain self-contained under
`src/app`, `src/components`, and `src/server`. Vendo is composed once in
`src/vendo/server.ts` with the host model, the session-backed principal, the
Supabase `actAs` preset for away execution, the deployed policy, optional
Vendo Auto judge, and Gmail/Google Calendar Composio connector.

The umbrella is mounted by the single catch-all route at
`/api/vendo/[...vendo]`. React surfaces use the umbrella `VendoRoot`, UI
chrome, Cadence's registered status/progress components, and the frozen theme
in `.vendo/theme.json`.

The committed `.vendo/` directory contains the frozen tools, overrides,
policy, brief, and theme documents. `vendo sync` runs before development and
production builds.

Cmd/Ctrl+K opens Vendo outside the full assistant page. Cmd/Ctrl+Shift+.
restores Cadence's deterministic product seed.
