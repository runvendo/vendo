# Worker A2 — actAs/credential-forwarding silent-trap fixes

You are a codex executor for Child A of the Vendo block-actions project
(Linear ENG-260). This brief is your task contract. The approved spec is at
`/Users/yousefh/orca/workspaces/flowlet/block-actions/docs/superpowers/specs/2026-07-14-block-actions-design.md`
(Section A, "Silent-trap fixes" bullet; read it first). Do not re-litigate
decisions recorded there.

## Grounding (from the spec's examination findings)

Present-mode credential forwarding is silently disabled unless the operator
sets `VENDO_BASE_URL`; away execution hard-requires a grant captured while the
user was present. Neither rule is documented anywhere. This chunk makes the
product loud about both.

## Deliverable

One PR to `main` (never commit to main directly) containing four fixes:

1. **`vendo init` writes `VENDO_BASE_URL`** into the env scaffold it
   generates, with a comment explaining that credential forwarding is disabled
   without it. See `packages/vendo/src/cli/init.ts` (+ `init.test.ts`, which
   already references VENDO_BASE_URL — understand what exists before changing).
2. **`vendo doctor` live probes** (see `packages/vendo/src/cli/doctor.ts`):
   - a probe that proves credentials actually arrive at the host API during
     present execution (round-trip through the running dev server, not a
     config check);
   - a probe that proves actAs mint+verify round-trips when the host has
     configured `actAs` (call it with a synthetic principal/grant, verify the
     returned AuthMaterial is accepted). Graceful, actionable failure text
     when the dev server isn't running or actAs isn't configured.
3. **One structured runtime warning** when present execution forwards nothing
   despite inbound auth headers on the request — emitted once (not per-call
   spam), structured (goes through whatever logging/audit convention
   `packages/vendo/src/server.ts` already uses; see the credential-forwarding
   logic around lines 640–770).
4. **Document the away-needs-present-grant rule** and the VENDO_BASE_URL
   requirement in `docs/` (follow existing doc conventions; keep it succinct).

## Key code pointers

- `packages/vendo/src/server.ts:657-770` — VENDO_BASE_URL trust + forwarding.
- `packages/vendo/src/cli/init.ts`, `doctor.ts` + their tests.
- `packages/core/src/host-seams.ts:8` — the ActAs seam type.
- `packages/actions/src/runtime/registry.ts:322` — away execution requires
  `config.actAs`; grants are captured while present.

## Rules

- TDD: failing test first. Doctor probes need integration-style tests against
  a real booted server fixture (look at `fixtures/integration` patterns from
  PR #136 for how tests boot real createVendo over HTTP).
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before the PR.
- Commit frequently with conventional messages.
- Open the PR with `gh pr create` (base main), title
  `fix(vendo): loud VENDO_BASE_URL + actAs silent-trap fixes (ENG-260)`.
- Update your Orca worktree comment at checkpoints: traps reproduced / fixes
  in / tests green / PR open.
- If you hit a genuine product-decision fork the spec doesn't settle, STOP and
  write the question into your worktree comment prefixed `ESCALATE:` — do not
  decide unilaterally.
