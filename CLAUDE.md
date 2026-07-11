# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/`: the published libraries (vendo, cli, client, components, core,
  react, runtime, sandbox-shims, server, shell, stage, store, telemetry)
- `apps/` — demo host apps (demo-bank "Maple", demo-accounting "Cadence")
- `docs/` — integration docs

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- `pnpm demo` — run the demo-bank host app (env setup: `apps/demo-bank/README.md`)
- `pnpm demo:accounting` — run the Cadence accounting demo
- `npx vendo init <dir>` — install Vendo into a Next.js app (interactive; safe to re-run).
  `vendo refresh` catches up an existing install; `vendo doctor` checks it; `vendo sync`
  runs in the build.

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
