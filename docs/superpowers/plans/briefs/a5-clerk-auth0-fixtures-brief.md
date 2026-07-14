# Worker A5 — Clerk + Auth0 minimal e2e fixture hosts

You are a codex executor for Child A of the Vendo block-actions project
(Linear ENG-260). This brief is your task contract. The approved spec is at
`/Users/yousefh/orca/workspaces/flowlet/block-actions/docs/superpowers/specs/2026-07-14-block-actions-design.md`
(Section A; read it first). Do not re-litigate decisions recorded there.

Prerequisite: the `@vendoai/actions/presets` subpath (worker A1's PR) is on
main. Read `packages/actions/src/presets/` first — the Clerk and Auth0
presets ship BOTH halves (away-token producer + host verify-middleware in
Next and Express flavors); your fixtures exercise those halves, they don't
redesign them.

## Deliverable

One PR to `main` (never commit to main directly) containing:

1. **Two minimal fixture hosts** (follow the existing `fixtures/` patterns —
   `fixtures/integration`, `fixtures/host-app` boot REAL `createVendo` over
   HTTP): one wired for Clerk, one for Auth0. Each mounts the preset's
   verify-middleware on its API routes and passes the preset's actAs producer
   to `createVendo`. Keep them as small as the existing fixtures allow.
2. **Keyless tests (always run)**: the away-token round-trip — preset mints,
   middleware verifies, request executes as the subject — proven against the
   fixture host without any provider account, since the Vendo away-token path
   doesn't need provider keys. Include negative cases (expired token, wrong
   subject, impersonation-guard mismatch).
3. **Live-keyed tests, `skipIf` credentials absent** (see the `skipIf`
   patterns in `fixtures/redteam`, `fixtures/mcp-e2e`,
   `fixtures/automations-e2e`): with real Clerk (CLERK_SECRET_KEY etc.) or
   Auth0 env keys present, prove present-mode session verification against
   the real provider. Names/env-var conventions should match the existing
   live tests.
4. README notes per fixture: which env vars enable live mode.

## Rules

- TDD; `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before
  the PR (with NO provider keys present — the default path must be green).
- Provider SDKs stay optional peers of the actions package or dev deps of the
  fixtures — dependency-guard (`pnpm lint`) stays green.
- Open the PR with `gh pr create` (base main), title
  `test(fixtures): Clerk + Auth0 actAs fixture hosts + live-keyed suites (ENG-260)`.
- Update your Orca worktree comment at checkpoints; prefix blockers with
  `ESCALATE:` and stop — do not decide product forks unilaterally.
