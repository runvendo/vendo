# Maple

Maple is a demo consumer neobank. It is the host app for the Vendo "$87 Mystery" product demo: a polished, believable banking UI that the Vendo agent embeds into. It is disposable and self-contained, kept separate from vendo-core so it can be reshaped or thrown away without touching the core product.

## Stack

- Next.js 16 (App Router)
- TypeScript
- Tailwind v4
- SWR for data fetching
- Framer Motion for animation
- Recharts for charts
- Radix UI primitives
- Vitest for tests

## Run it

```bash
cd apps/demo-bank
npm install
npm run dev
```

Open http://localhost:3000.

```bash
npm run build   # production build
npm test        # vitest
```

## Architecture

Every screen is backed by a real HTTP API. The UI never imports seed data directly. The flow:

```
seeded in-memory store          src/server/store.ts + src/server/seed.ts
        ->
repositories                    src/server/{accounts,transactions,cards,insights,payments,notifications}.ts
        ->
Route Handlers                  src/app/api/**
        ->
typed client + SWR hooks        src/lib/api-client.ts + src/lib/hooks.ts
        ->
pages                           src/app/**
```

The store is seeded once in memory, deterministically, via a seeded PRNG in `src/server/prng.ts`. Repositories read from the store and apply filtering, sorting, and pagination. Route Handlers expose them under `/api/*`. The browser fetches those endpoints over HTTP through the typed client and SWR hooks. Pages never reach into the seed directly.

## API endpoints

- `GET /api/profile`
- `GET /api/accounts`
- `GET /api/accounts/:id`
- `GET /api/accounts/:id/transactions`
- `GET /api/transactions` (query params: `search`, `category`, `accountId`, `status`, `from`, `to`, `min`, `max`, `sort`, `limit`, `cursor`)
- `GET /api/transactions/:id`
- `GET /api/cards`
- `GET /api/cards/:id/transactions`
- `GET /api/insights/spending`
- `GET /api/insights/cashflow`
- `GET /api/insights/budgets`
- `GET /api/insights/recurring`
- `GET /api/payees`
- `GET /api/payments/scheduled`
- `GET /api/goals`
- `GET /api/notifications`

All `/api/*` routes are dynamic (server-rendered on demand).

## Pages

Home, Accounts, Transactions, Cards, Payments, Insights, Activity, Settings.

## The planted charge

The demo anchors on one transaction: `txn_doordash_87`, an $87.00 DoorDash charge at 1:14 AM on Maple Checking (`amount: -8700`, `category: dining`, descriptor `DOORDASH*ORDER 8742 CA`). It is the most recent transaction in the seed and the thing the Vendo "$87 Mystery" demo investigates. The seed is deterministic, so the charge and surrounding data are identical on every run.

## Vendo sandbox and generated views

There is ONE UI tool, `render_view`, and its output always renders in the sandbox. Pre-built catalog components are building blocks placed inside a generated view; even a single component is a one-node generated view rendered in the box. The path:

- The agent calls `render_view` with a `GeneratedPayload` (a flat `nodes` array plus a `root` id; nodes can be prewired primitives, host catalog components, or novel generated code). That becomes a `kind: "generated"` UI node, which `SandboxStage` mounts into the egress-jailed stage. The stage loads the components host bundle plus the React shim, copied into `public/vendo/` by the `predev`/`prebuild` hook (`scripts/copy-vendo-sandbox.mjs`).
- The one host-rendered exception is the Connect card, emitted by `request_connect`. OAuth needs host privileges, so this card is rendered and trusted directly by the demo host rather than in the sandbox.
- The demo runs a real guardrail policy (`src/vendo/policy.ts`), replacing the old allow-all. The UI tools plus in-process reads (`render_view`, `request_connect`, `get_transactions`, `list_automations`, `get_automation_runs`) and read-shaped Composio tools (FETCH, GET, LIST, SEARCH, FIND, READ) resolve to `allow`. Write-shaped or unknown tools — including `create_automation` and the other authoring writes — resolve to `approve`. The same policy governs automation firings: the interpreter evaluates it per step, and approve-gated steps run unattended only under a scope-hashed grant.
- Actions from a sandbox component (`vendo.dispatch`) route through `POST /api/vendo/action`, which runs them through the SAME `demoPolicy` before executing.

### Theming

One `BrandTokens` object, `mapleBrand` (`src/vendo/brand.ts`), is the single brand source of truth for both surfaces. Two derivations run off it:

- `brandToCssVars(mapleBrand)` produces the canonical `--vendo-*` CSS variables (accent, bg, surface, fg, border, shadow, skeleton). These are applied to the host shell chrome (via `VendoThemeProvider` / `.vendo-root`) and injected into the sandbox stage as its `theme`.
- `mapBrandToTheme(mapleBrand)` produces the OpenUI component theme, passed to the sandbox as `componentTheme` and mounted there by the bundle's ThemeProvider wrapper.

So the shell and the generated/sandbox UI render from the same brand and cannot drift. There is no `--brand-*` scope anymore; `--vendo-*` is the only token namespace.

### Known limitations

1. The action route's approval re-POST is trusted: the client sends `approved: true`. Acceptable for this local-only demo; a production build needs a server-side approval token.
2. Approve-gated actions have no in-process executor in this demo, so clicking "Allow" on the sandbox approval prompt 404s. The approval UI is effectively vestigial for the demo's toolset. The available sandbox action is `get_transactions`, which is allowed and executes directly. (Standing rules are automations now — created through the chat agent's approval-gated `create_automation`, not through a sandbox dispatch.)
3. A denied sandbox `dispatch()` resolves `undefined` to the generated component rather than rejecting: the runtime's direct-reply path only propagates `result`, not errors. The server never executes the denied action, so this is a UX/semantics gap, not a security hole.
4. Arbitrary interactive apps (e.g. games) are now expressed as novel generated components inside a `render_view` view, so they render in the same egress-jailed sandbox as everything else. Novel components may be authored in JSX/TSX: the source is compiled server-side at the `render_view` boundary with the automatic React runtime (no need to import React), then rendered in the sandbox. `React.createElement` still works.
5. Images are data-URI-only inside the sandbox. The stage CSP is `img-src data:` (part of the egress jail), so remote/https images are intentionally blocked, both because they render broken and because a remote image src is an exfiltration vector. The component library agrees with this: `allowlistUrl` accepts only safe `data:image` URIs. Re-enabling remote images safely, via a governed image proxy, is a future follow-up.

## Out of scope (this issue)

- The Vendo embed and agent
- Gmail receipt lookup
- Slack integration
- API writes and mutations

The repository layer is shaped to add writes later, but only reads exist today. All form, card, and settings controls are presentational.
