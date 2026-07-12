# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout (v0 rebuild in progress — waves 3+)

- `packages/` — the active workspace: new blocks built fresh against the FROZEN
  contracts in `docs/contracts/` (read `00-overview.md` first), plus `vendo-telemetry`
  (orthogonal, unchanged)
- `legacy/` — the pre-v0 packages and demo apps: a **read-only quarry**, out of the
  workspace, never imported by new packages (enforced by `scripts/dependency-guard.mjs`
  in `pnpm lint`); deleted wave by wave, gone by wave 7
- `corpus/` — init-extraction corpus harness; red by design until wave 7
- `docs/` — integration docs

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- Demo apps are quarried under `legacy/apps/` until wave 7 (`pnpm demo` returns then).

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
