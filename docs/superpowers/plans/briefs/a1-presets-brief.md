# Worker A1 — @vendoai/actions/presets + impersonation guard

You are a codex executor for Child A of the Vendo block-actions project
(Linear ENG-260). This brief is your task contract. The approved spec is at
`/Users/yousefh/orca/workspaces/flowlet/block-actions/docs/superpowers/specs/2026-07-14-block-actions-design.md`
(Section A governs; read it first). Do not re-litigate decisions recorded there.

## Deliverable

One PR to `main` (never commit to main directly; work on your worktree branch)
containing:

1. **New subpath `@vendoai/actions/presets`** (add a `./presets` entry to
   `packages/actions/package.json` `exports`, built by the existing tsc build).
   It ships actAs presets for:
   - **Auth.js / NextAuth**: native offline session-token minting using the
     host's own `AUTH_SECRET`. Note Auth.js v5 session JWTs are encrypted
     (JWE); mint what the host's `getToken`/session verification will actually
     accept. Verify against the real `@auth/core` implementation in tests.
   - **Supabase Auth**: native offline minting — HS256 JWT signed with the
     project JWT secret (claims: sub, role=authenticated, aud, exp).
   - **Clerk** and **Auth0**: offline minting is impossible (RS256, keys held
     by the provider). Each preset ships BOTH halves: (a) an actAs producer
     that signs a short-lived **Vendo away-token**, and (b) a small
     **verify-middleware** the host mounts on its API — in BOTH Next.js and
     Express flavors. You design the token format/secret provisioning; keep it
     minimal, document it, and make doctor-probeable round-trips possible.
   - **Generic JWT**: configurable preset (secret/claims/header shape) for the
     long tail.
2. **Token caching inside preset closures** until expiry (with a safety
   margin). `AuthMaterial` stays exactly `{ headers }` — the contract type in
   `packages/core/src/host-seams.ts` does NOT change.
3. **Provider SDKs as optional peer deps** of the actions package only
   (`peerDependencies` + `peerDependenciesMeta.optional`). Import them lazily
   inside the specific preset so hosts not using a provider never need it.
   `node scripts/dependency-guard.mjs` (part of `pnpm lint`) must stay green.
4. **Impersonation guard**: in `packages/actions/src/runtime/registry.ts`, the
   shared actAs invocation (`actAsAuth`, ~line 259, used by the away branch
   ~line 322 and MCP branch ~line 345) must assert
   `grant.subject === ctx.principal.subject` before calling the host's actAs,
   failing closed with a structured error outcome when it mismatches. Add
   tests for the mismatch path.
5. **Copy-paste recipes doc** for long-tail providers (follow existing
   conventions in `docs/` — look at how other integration docs are written).

## Key code pointers

- `packages/core/src/host-seams.ts:8` — `ActAs = (principal, grant) =>
  Promise<AuthMaterial | null>`; null = host declined (run fails closed).
- `packages/actions/src/runtime/registry.ts` — the ONLY consumer of actAs.
- `packages/core/src/conformance/index.ts:426` — `actAsConformance` harness;
  your presets should pass it, extend it if it has gaps.
- `packages/actions/package.json` — currently single `.` export.
- Layering: actions may depend on core only; the dependency guard enforces it.

## Rules

- TDD: failing test first, then implementation. Unit tests per preset
  (mint/cache/expiry/decline paths) + integration tests where a real verify
  (e.g. `@auth/core`, `jsonwebtoken`/`jose` for Supabase claims, your own
  middleware for Clerk/Auth0) accepts the minted material.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before the PR.
- Commit frequently with conventional messages.
- Open the PR with `gh pr create` (base main), title
  `feat(actions): actAs presets subpath + impersonation guard (ENG-260)`.
- Update your Orca worktree comment (`orca worktree set --worktree active
  --comment "..."`) at checkpoints: seam understood / presets built / tests
  green / PR open.
- If you hit a genuine product-decision fork the spec doesn't settle, STOP and
  write the question into your worktree comment prefixed `ESCALATE:` — do not
  decide unilaterally.
