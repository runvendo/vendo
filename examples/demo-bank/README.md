# Maple

Maple is a self-contained consumer-neobank demo for Vendo's "$87 Mystery"
story. Its deterministic seed includes an $87 DoorDash charge at 1:14 AM,
alongside accounts, cards, transactions, goals, payments, and spending
insights.

## Try the demo

The live demo runs at **https://maple.vendo.run**. Sign in with the public
demo credentials:

- **Email:** `yousef@maple.com`
- **Password:** `maple-demo`

These are intentionally public, non-secret credentials for a fictional demo
bank — no real money moves. A second seeded user, `mia@maple.com` (same
password), exists to demonstrate per-user isolation.

## Setup

```bash
cd examples/demo-bank
cp .env.example .env.local
# Fill in VENDO_API_KEY (+ VENDO_DEV_CREDENTIAL=vendo-cloud, MAPLE_STORE=local
# — the standing local posture; see "Store posture") or ANTHROPIC_API_KEY for
# a BYO model key. OPENAI_API_KEY enables realtime voice.
pnpm dev
```

A bare `pnpm dev` with that `.env.local` boots the full posture — Cloud model
gateway (`[vendo] model: VENDO_API_KEY (Vendo Cloud)` on first model use),
Cloud connections broker, local PGlite store — with no shell exports.

Open http://localhost:3000. Run `pnpm test` for the host API suite (it
includes the ENG-260 away drill, which boots a real Maple instance).

## Authentication

Maple uses real Auth.js (NextAuth) authentication with the credentials
provider — no external services. Two demo users are seeded so per-user
isolation is demonstrable: `yousef@maple.com` and `mia@maple.com`, both with
password `maple-demo` outside production (`MAPLE_DEMO_PASSWORD` overrides;
required in production, as is `AUTH_SECRET`). Sign in at `/login`; sign out at
`POST /logout` (the account menu's Sign out — it clears the Auth.js session
cookie). Pages redirect to `/login` and the bank API answers 401
without a session (`src/proxy.ts`).

The account menu's **Switch account** list is the seeded roster, and it is
empty exactly when password login is unconfigured — production with no
`MAPLE_DEMO_PASSWORD`. The menu then says so ("Account switching is off") and
names the env var, because switching signs in through the credentials flow.
Locally the password defaults to `maple-demo`, so both users are always there.

The Auth.js session is the identity for everything, wired with one config key
— `auth: authJs({ secret: authSecret, user })` in `src/vendo/server.ts`: the
Vendo principal is the session's user id, the MCP OAuth adapter resolves the
same session, and away execution mints REAL session tokens for the granting
user through the same Auth.js preset with the host's own `AUTH_SECRET`.
Present execution forwards the signed-in user's cookie to `VENDO_BASE_URL`.
Secrets must never be committed.

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

## Store posture

The Vendo store slot is an explicit demo decision, wired in
`src/vendo/server.ts`:

- **Deployed (Railway): the Cloud hosted store.** The slot stays unset, so the
  `VENDO_API_KEY` env ladder composes Vendo Cloud's hosted store. Railway's
  container filesystem is ephemeral — a container-local store would silently
  wipe demo threads, pins, and grants on every redeploy; hosted state
  survives, and Cloud stays the single firing authority for the demo's
  schedule automations. Do not set `MAPLE_STORE` on the service.
- **Local dev: a local PGlite store.** `.env.local` sets `MAPLE_STORE=local`,
  which pins `createStore()` (data under `.vendo/data/`, gitignored) so a
  laptop never shares the deployed demo's Cloud tenant. Unset it (while
  keeping `VENDO_API_KEY`) to run locally against the hosted store — the
  scripted seeding, beats, and reset all go through the store-agnostic
  records door and work identically on both.

## Railway and public-origin configuration

Railway builds `examples/demo-bank/Dockerfile` from the monorepo root. Configure the
service with `VENDO_API_KEY` (composes the hosted store and Cloud model
gateway — see "Store posture"), `VENDO_BASE_URL`, `AUTH_SECRET`,
`MAPLE_DEMO_EMAIL`, and `MAPLE_DEMO_PASSWORD`.
`VENDO_BASE_URL` is the one public-origin switch: set it to the
default Railway origin first, then change it to `https://maple.vendo.run` after
DNS is live and redeploy. It is the ORIGIN only, never the mount point — host
tool bindings already carry `/maple`, and `src/vendo/mcp-config.ts` adds it to
the MCP door's public base. Without it the door has no way to learn where it
is, and every URL it advertises 404s.

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
consent page, a seeded account tool (walking its in-product approval if the
guard asks for one), and a money transfer that the guard must refuse:

```bash
pnpm --filter demo-bank mcp:e2e
```

The argument is Maple's ORIGIN and defaults to `http://localhost:3000`; where
Maple sits on it comes from the app's own mount point, so
`http://localhost:3000/maple` is the same run. `VENDO_BASE_URL` must be set to
that origin for the door's discovery documents to name URLs a client can reach.

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
