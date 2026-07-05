# Flowlet

Flowlet is a devtool that lets a company's users customize its product: an embedded agent that acts through the host's own API as the user and renders generated UI in a sandboxed, brand-native surface.

## Read first

- [`docs/PRD.md`](docs/PRD.md) — product intent (Notion is the source of truth; this is a synced snapshot)
- [`docs/superpowers/specs/2026-07-01-flowlet-platform-architecture-design.md`](docs/superpowers/specs/2026-07-01-flowlet-platform-architecture-design.md) — the locked platform architecture. Build against its seams; if your task conflicts with it, stop and surface the conflict.
- `docs/superpowers/specs/` — per-epic point-in-time designs

## Standing rules

- No product, architecture, or scope decisions on your own — surface the question and stop.
- All UI/UX work pauses for Yousef's review: before building it, and again before merging it. Nothing visual ships without him.
- Open PRs; never merge. Yousef merges.
- If you're in an Orca-managed worktree, keep its comment updated at meaningful checkpoints (`orca worktree set --worktree active --comment "..."`).

## Shipping

- Always a feature branch or worktree; never commit on main.

## Verification

- Any UI-affecting change is verified in a real browser with screenshots in the PR. Tests and typecheck alone don't count.

## Skills

- Superpowers skills are mandatory: invoke `using-superpowers` at conversation start, then any matching skill when its trigger hits (brainstorming, writing-plans, test-driven-development, systematic-debugging, verification-before-completion, etc.).

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- `pnpm demo` — run the demo-bank host app (secrets via Infisical)
- `pnpm demo:accounting` — run the Cadence accounting demo app (secrets via Infisical: the embedded Flowlet agent needs `ANTHROPIC_API_KEY`)
- `node packages/flowlet-cli/dist/cli.js init <dir>` — one-command install: extractor (ENG-197) + Next.js App Router codemod (route handler, provider wrap, .env.example, sandbox assets); LLM steps need a provider key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GOOGLE_GENERATIVE_AI_API_KEY`), else deterministic extraction; `publish` is stubbed until ENG-198. Install story: [`docs/quickstart.md`](docs/quickstart.md)
