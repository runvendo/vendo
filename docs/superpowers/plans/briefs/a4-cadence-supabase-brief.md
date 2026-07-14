# Worker A4 — Cadence (demo-accounting) → Supabase Auth + away drill

You are a codex executor for Child A of the Vendo block-actions project
(Linear ENG-260). This brief is your task contract. The approved spec is at
`/Users/yousefh/orca/workspaces/flowlet/block-actions/docs/superpowers/specs/2026-07-14-block-actions-design.md`
(Section A; read it first). Do not re-litigate decisions recorded there.

Prerequisite: the `@vendoai/actions/presets` subpath (worker A1's PR) is on
main. Read `packages/actions/src/presets/` before starting — you consume it,
you don't redesign it.

## Current state

demo-accounting fakes auth the same way demo-bank does: a fixed demo principal
in `apps/demo-accounting/src/vendo/principal.ts` passed to `createVendo` in
`src/vendo/server.ts`, no `actAs`.

## Deliverable

One PR to `main` (never commit to main directly) converting Cadence to
Supabase Auth:

1. **Supabase Auth via Supabase local** (`supabase start` CLI stack) in dev
   and CI: real email/password login in Cadence's brand, seeded demo users
   (at least two). Document the local setup in the README; CI must either run
   Supabase local or skip the Supabase-dependent suites cleanly — pick
   whichever the repo's CI can sustain and say which you chose in the PR.
2. **Principal resolver reads the real Supabase session** (subject = Supabase
   user id). No more fixed principal.
3. **`actAs` wired to the Supabase preset** from `@vendoai/actions/presets`
   using the project JWT secret, so away execution mints real user JWTs that
   the demo's API accepts.
4. **Away drill proven end-to-end**: an automation fires with NO live user
   session and its action executes as the granting user. Automate it (see
   `fixtures/automations-e2e/` patterns) AND run it for real once, capturing
   evidence.
5. Env/seed updates: `.env.example`, README, `VENDO_BASE_URL` set.

## Warnings

- `apps/demo-accounting/AGENTS.md` (and demo-bank's): nonstandard Next.js —
  read `node_modules/next/dist/docs/` before touching routes/middleware.
- UI-affecting change: login flow verified in a real browser with screenshots
  in the PR body (login page, signed-in execution, away-drill evidence).
- Supabase local must not become a hard dependency for unrelated repo tests.

## Rules

- TDD where testable; `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
  green before the PR. Also `pnpm --filter demo-accounting dev` boots and works.
- Open the PR with `gh pr create` (base main), title
  `feat(demo-accounting): Supabase Auth login + actAs away execution (ENG-260)`.
- Update your Orca worktree comment at checkpoints; prefix blockers with
  `ESCALATE:` and stop — do not decide product forks unilaterally.
