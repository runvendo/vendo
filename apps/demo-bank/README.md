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

Open http://localhost:3000. Run `pnpm test` for the host API suite.

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
