# Maple

Maple is a self-contained consumer-neobank demo for Vendo's "$87 Mystery"
story. Its deterministic seed includes an $87 DoorDash charge at 1:14 AM,
alongside accounts, cards, transactions, goals, payments, and spending
insights.

## Setup

```bash
cd apps/demo-bank
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY; OPENAI_API_KEY enables realtime voice.
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the host API suite (it
includes the ENG-260 away drill, which boots a real Maple instance).

## Authentication

Maple uses real Auth.js (NextAuth) authentication with the credentials
provider — no external services. Two demo users are seeded so per-user
isolation is demonstrable: `yousef@maple.com` and `mia@maple.com`, both with
password `maple-demo` outside production (`MAPLE_DEMO_PASSWORD` overrides;
required in production, as is `AUTH_SECRET`). Sign in at `/login`; sign out at
`/api/auth/signout`. Pages redirect to `/login` and the bank API answers 401
without a session (`src/proxy.ts`).

The Auth.js session is the identity for everything: the Vendo principal is the
session's user id (`src/vendo/principal.ts`), the MCP OAuth adapter resolves
the same session, and away execution mints REAL session tokens for the
granting user through the `@vendoai/actions/presets` Auth.js preset with the
host's own `AUTH_SECRET` (`actAsMapleUser` in `src/vendo/auth.ts`). Present
execution forwards the signed-in user's cookie to `VENDO_BASE_URL`. Secrets
must never be committed.

## Architecture

Every product screen uses the real Route Handlers under `src/app/api` through
the typed client and SWR hooks. The deterministic in-memory store lives under
`src/server`; pages do not import seed data.

Vendo is composed once in `src/vendo/server.ts` with
`createVendo({ model, principal, policy, connectors })` and mounted by the
single catch-all route at `/api/vendo/[...vendo]`. The React surface uses the
umbrella `VendoRoot`, UI chrome/tree/voice subpaths, Maple's registered host
components, and the frozen theme in `.vendo/theme.json`.

The `.vendo/` directory is the committed host contract: tools, overrides,
policy, product brief, and theme. `vendo sync` runs before development and
production builds.

Realtime voice mints a short-lived browser credential at `POST /api/voice`
and then uses the UI package's WebRTC driver. The current frozen voice seam
carries state and transcripts; legacy voice-only tool/view choreography is
documented at its migration site.

Cmd/Ctrl+K opens Vendo. Cmd/Ctrl+Shift+. restores Maple's deterministic seed.

## Railway and public-origin configuration

Railway builds `apps/demo-bank/Dockerfile` from the monorepo root. Configure the
service with `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `VENDO_BASE_URL`,
`AUTH_SECRET`, `MAPLE_DEMO_EMAIL`, and `MAPLE_DEMO_PASSWORD`. The
Postgres URL keeps Vendo's OAuth, approval, audit, and app state across
redeploys. `VENDO_BASE_URL` is the one public-origin switch: set it to the
default Railway origin first, then change it to `https://maple.vendo.run` after
DNS is live and redeploy.

For a fast local HTTPS iteration loop, this machine has Tailscale Funnel:

```bash
pnpm --filter demo-bank dev
tailscale funnel --bg 3000
tailscale funnel status
```

Copy the HTTPS origin printed by `tailscale funnel status` into the ignored
local environment as `VENDO_BASE_URL`, restart Maple, and verify discovery
through the funnel. Stop the tunnel with `tailscale funnel reset`. The tunnel is
only for iteration and is not part of the Railway deployment.

The real-SDK proof runs discovery, DCR, PKCE, Maple login, the door-owned
consent page, a seeded account tool, and a destructive transfer that parks for
in-product approval before succeeding on retry:

```bash
pnpm --filter demo-bank mcp:e2e -- http://localhost:3000
```

## Broker-fronted MCP (remote authorization server)

By default the door serves its own OAuth surface. To front Maple with the
Vendo hosted broker (`{tenant}.mcp.vendo.run`), provision a tenant against the
broker with `upstream_origin`/`upstream_mount` pointing at this app's public
origin and `/api/vendo/mcp`, then set:

- `VENDO_MCP_REMOTE_AS_ISSUER` — the tenant issuer, e.g. `https://maple.mcp.vendo.run`
- `VENDO_MCP_REMOTE_AS_AUDIENCE` — expected token audience (defaults to `{issuer}/mcp`)
- `VENDO_MCP_REMOTE_AS_JWKS_URI` — optional JWKS override (defaults to RFC 8414 discovery)
- `VENDO_MCP_FEDERATION_SECRET` — the federation secret returned once at provisioning

With these set, Maple stops serving `/authorize`, `/token`, and `/register`
(the broker owns them), validates broker-issued ES256 bearers, and answers the
broker's signed login handshake at `/api/vendo/mcp/federate` with Maple's own
session. Pending agent actions — including door calls parked for consent —
surface in-product on the Vendo tab's approvals inbox.
