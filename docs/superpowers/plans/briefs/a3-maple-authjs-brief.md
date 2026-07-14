# Worker A3 — Maple (demo-bank) → real Auth.js login + away drill

You are a codex executor for Child A of the Vendo block-actions project
(Linear ENG-260). This brief is your task contract. The approved spec is at
`/Users/yousefh/orca/workspaces/flowlet/block-actions/docs/superpowers/specs/2026-07-14-block-actions-design.md`
(Section A; read it first). Do not re-litigate decisions recorded there.

Prerequisite: the `@vendoai/actions/presets` subpath (worker A1's PR) is on
main. Read `packages/actions/src/presets/` before starting — you consume it,
you don't redesign it.

## Current state

demo-bank fakes auth: `apps/demo-bank/src/vendo/principal.ts` returns a fixed
`DEMO_PRINCIPAL` (`vendo-demo`) for any local request; `src/vendo/server.ts`
passes it to `createVendo` and configures no `actAs`.

## Deliverable

One PR to `main` (never commit to main directly) converting Maple to real
Auth.js authentication:

1. **Auth.js (NextAuth) with the credentials provider**: real login page in
   Maple's brand, seeded demo users (at least two, so per-user isolation is
   demonstrable), real session tokens. Keep the demo bootable with zero
   external services.
2. **Principal resolver reads the real session** — `resolveDemoPrincipal`
   becomes a session-backed resolver (subject = the Auth.js user id). No more
   fixed principal.
3. **`actAs` wired to the Auth.js preset** from `@vendoai/actions/presets`,
   using the host's `AUTH_SECRET`, so away execution mints real session
   tokens.
4. **Away drill proven end-to-end**: an automation fires with NO live user
   session and its action executes as the granting user against the demo's
   own API. Automate it as an integration/e2e test (see
   `fixtures/automations-e2e/` for patterns) AND run it for real once,
   capturing evidence.
5. Seed/env updates: `.env.example`, README, `VENDO_BASE_URL` set (needed for
   credential forwarding).

## Warnings

- `apps/demo-bank/AGENTS.md`: this is NOT the Next.js you know — breaking
  changes vs training data. Read `node_modules/next/dist/docs/` for anything
  you touch (routes, middleware, auth wiring).
- UI-affecting change: the login flow and any chrome changes MUST be verified
  in a real browser; put screenshots in the PR body (login page, signed-in
  execution, away-drill evidence).
- Don't break the voice route or other demo features that read the principal.

## Rules

- TDD where testable; `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
  green before the PR. Also `pnpm --filter demo-bank dev` boots and works.
- Open the PR with `gh pr create` (base main), title
  `feat(demo-bank): real Auth.js login + actAs away execution (ENG-260)`.
- Update your Orca worktree comment at checkpoints; prefix blockers with
  `ESCALATE:` and stop — do not decide product forks unilaterally.
