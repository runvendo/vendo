# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/` — the published `@vendoai/*` libraries (core, server, runtime,
  react, next, shell, components, stage, store, telemetry, cli)
- `apps/` — demo host apps (demo-bank "Maple", demo-accounting "Cadence")
- `examples/` — minimal usage examples
- `docs/` — integration docs

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- `pnpm demo` — run the demo-bank host app (env setup: `apps/demo-bank/README.md`)
- `pnpm demo:accounting` — run the Cadence accounting demo
- `npx @vendoai/cli init <dir>` — install Vendo into a Next.js app

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
