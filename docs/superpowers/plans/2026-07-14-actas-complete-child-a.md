# actAs Complete (Child A) — Orchestration Plan

Spec: `docs/superpowers/specs/2026-07-14-block-actions-design.md` Section A (parent
worktree, commit 6969a6c7). Linear: ENG-260. Orchestrator: Child A Fable session;
all execution delegated to codex sol workers in child worktrees.

**Goal:** The ActAs seam goes from zero implementations to a shipped preset tier
(Auth.js, Clerk, Supabase, Auth0, generic JWT), both demos on real auth, away
execution proven end-to-end, and the silent traps (VENDO_BASE_URL, undocumented
away-needs-present-grant rule) fixed in product.

## Chunks and PRs

Each chunk is one codex worker in its own child worktree, one PR to main.

**A1 — presets subpath + impersonation guard** (wave 1)
- `@vendoai/actions/presets` subpath export; presets for Auth.js/NextAuth,
  Supabase Auth (native offline token minting with host secrets), Clerk, Auth0
  (Vendo away-token producer + host verify-middleware, Next and Express
  flavors), plus generic JWT preset.
- Token caching inside preset closures until expiry. `AuthMaterial` stays
  `{ headers }` — no contract change.
- Provider SDKs as optional peer deps of the subpath only; dependency-guard
  stays green.
- Impersonation guard at the actAs seam in the actions registry:
  `grant.subject === ctx.principal.subject` or the run fails closed.
- Copy-paste recipes doc for the long tail of providers.
- Unit + integration tests; no UI surface.

**A2 — silent-trap fixes** (wave 1, parallel with A1)
- `vendo init` writes `VENDO_BASE_URL` into the env scaffold.
- `vendo doctor` live probes: credentials actually arrive at the host API;
  actAs mint+verify round-trip.
- Runtime emits one structured warning when present execution forwards nothing
  despite inbound auth headers.
- Document the away-needs-present-grant rule in docs/.

**A3 — Maple (demo-bank) → real Auth.js** (wave 2, needs A1)
- Credentials provider, seeded demo users, real session tokens; Auth.js preset
  wired as `actAs`.
- Away drill proven: an automation fires with no live user session and the
  action executes as the user. Browser-verified with screenshots.

**A4 — Cadence (demo-accounting) → Supabase Auth** (wave 2, needs A1)
- Supabase local in dev/CI; Supabase preset wired as `actAs`.
- Same away drill + browser verification bar as A3.

**A5 — Clerk + Auth0 e2e fixture hosts** (wave 2, needs A1)
- Minimal fixture hosts booting real `createVendo`, exercising the away-token +
  verify-middleware halves; live-keyed tests `skipIf` credentials absent.

## Sequencing

Wave 1: A1 + A2 in parallel. Wave 2: A3 + A4 + A5 in parallel once A1's PR is
merged (or its branch is stable enough to stack on, orchestrator's call).

## Quality gates (every PR)

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- UI-affecting changes (A3/A4 logins, demo chrome) verified in a real browser
  with screenshots in the PR.
- Away drill actually runs on both converted demos — end-to-end proof, not
  unit tests.

## Escalation

New decision forks the spec doesn't settle go to the parent orchestrator
(worktree d15b1b59-6857-4421-b358-c8040f561532), not decided here.
