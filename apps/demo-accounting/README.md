# Cadence

Cadence is the Vendo practice-management demo for client onboarding,
tax-document collection, filing deadlines, and client messaging.

## Setup

```bash
cd apps/demo-accounting
cp .env.example .env.local
# Fill in ANTHROPIC_API_KEY. COMPOSIO_API_KEY enables Gmail and Calendar.
pnpm dev
```

Open http://localhost:3000. Run `pnpm test` for the host API suite.

## Architecture

Cadence's product pages and seeded data remain self-contained under
`src/app`, `src/components`, and `src/server`. Vendo is composed once in
`src/vendo/server.ts` with the host model and principal, the deployed policy,
optional Vendo Auto judge, and Gmail/Google Calendar Composio connector.

The umbrella is mounted by the single catch-all route at
`/api/vendo/[...vendo]`. React surfaces use the umbrella `VendoRoot`, UI
chrome, Cadence's registered status/progress components, and the frozen theme
in `.vendo/theme.json`.

The committed `.vendo/` directory contains the frozen tools, overrides,
policy, brief, and theme documents. `vendo sync` runs before development and
production builds.

Cmd/Ctrl+K opens Vendo outside the full assistant page. Cmd/Ctrl+Shift+.
restores Cadence's deterministic product seed.
