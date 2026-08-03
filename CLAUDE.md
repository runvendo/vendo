# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/` — the ten `@vendoai/*` blocks + the `@vendoai/vendo` umbrella and
  `vendoai` alias, built against the archived contracts in `docs/archive/contracts/`
  (read `00-overview.md` first); layering enforced by `scripts/dependency-guard.mjs`
  in `pnpm lint`
- `apps/` — the two demo hosts, `demo-bank` (Maple) and `demo-accounting` (Cadence),
  plus `demo-template` (the skeleton the demo-creator clones per prospect)
- `corpus/` — init-extraction corpus harness (`pnpm corpus`)
- `docs/` — integration docs; `docs-site/` — the public docs site

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- Demos: `pnpm --filter demo-bank dev` (Maple) · `pnpm --filter demo-accounting dev` (Cadence)
- Both demo `dev` scripts run `scripts/dev-with-port-fallback.mjs`, which probes
  for the first free port from 3000 upward (bounded to 3000-3010), then launches
  `next dev -p <that port>`. When `VENDO_BASE_URL` is unset or a localhost origin
  (the `.env.example` default `http://localhost:3000`), it exports
  `VENDO_BASE_URL=http://localhost:<that port>` so the credential-trusted origin
  stays in sync with the bound port by construction (no drift, no manual step).
  Only a NON-LOCAL origin — a funnel/tunnel/deployed host set in the shell or any
  of the demo's `.env*` files, which the wrapper loads the way Next does (e.g.
  the Tailscale funnel origin the demo-bank README pins in `.env.local`) — is a
  deliberate operator setting and is left untouched. A fallback prints one line
  and only 3000-3010 exhausted is a loud failure.

## Vendo Cloud

- Cloud sells exactly two categories: infrastructure that is painful to run
  yourself (sandbox, inference, persistence, brokers, hosted automations) and
  inherently multi-party coordination (sharing, registry, orgs, SSO, billing,
  console). Everything else stays OSS.
- Hard BYO rule: every single-player capability keeps a no-key
  bring-your-own path (own Postgres, sandbox account, model key, OAuth apps).
- Adapter rule: one adapter interface per block; Cloud is just another
  implementation shipped in OSS. `VENDO_API_KEY` sets Cloud defaults only for
  adapter slots the host left unset; an explicitly passed adapter always
  wins; no hidden key-conditional branches. Reference implementation:
  `selectConnections` in `packages/vendo/src/server.ts`.
- Gating is valid key + meter, nothing else: no capability booleans, no
  entitlement protocol, no validate endpoint, no client-side checks. Key
  problems surface on the first real service call.
- Managed inference rides the console's Anthropic-compatible model gateway
  through the stock `@ai-sdk/anthropic` provider, so inference traffic does
  not carry the deployment-identity headers and does not feed the deployment
  inventory (known, accepted).

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
