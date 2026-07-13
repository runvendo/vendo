# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/` — the nine `@vendoai/*` blocks + the `@vendoai/vendo` umbrella and
  `vendoai` alias, built against the FROZEN contracts in `docs/contracts/`
  (read `00-overview.md` first); layering enforced by `scripts/dependency-guard.mjs`
  in `pnpm lint`
- `apps/` — the two demo hosts: `demo-bank` (Maple) and `demo-accounting` (Cadence)
- `corpus/` — init-extraction corpus harness (`pnpm corpus`)
- `docs/` — integration docs; `docs-site/` — the public docs site

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- Demos: `pnpm --filter demo-bank dev` (Maple) · `pnpm --filter demo-accounting dev` (Cadence)

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
