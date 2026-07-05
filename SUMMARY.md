# Summary

Branch: `yousefh409/shell-polish`

Rebased onto current `origin/main` after PR #53.

Implementation commits:
- `a644c69a` Fix scoped overlay clear button layout
- `57bd8ee1` Add persistent VendoRemix affordance option
- `92703c11` Fix VendoRemix affordance review findings

Changes:
- Reserved a right-side gutter in the scoped overlay header so `.fl-scope-clear` stays inline with the scope bar and no longer collides with `.fl-overlay-close`.
- Added `VendoRemix` prop `affordance?: "hover" | "always"` with the default unchanged at `"hover"`.
- Added CSS for `.fl-remix-btn[data-affordance="always"]` so the remix affordance is persistently visible when opted in.
- Updated VendoRemix tests for the default and always-visible affordance modes.

FIXED:
- Review MEDIUM: `VendoRemix` now emits `data-affordance` only for `affordance="always"`; the default mounted button omits the attribute.
- Review LOW: Added a file-read CSS contract test asserting the `always` selector sets `opacity: 1` and `transform: scale(1)`, while the default hidden and hover/focus reveal rules remain present.

Verification:
- `pnpm --filter @vendoai/shell test -- src/remix/VendoRemix.test.tsx`: passed, 10 tests.
- `pnpm test` in `packages/vendo-shell`: passed, 61 files and 334 tests.
- `pnpm build` in `packages/vendo-shell`: passed.
- `pnpm build` at repo root: passed, 19 of 19 turbo tasks.

Notes:
- The shell test suite still emits existing React `act(...)` and in-memory store warnings.
- The root build still emits existing bundle-size, Turbopack NFT trace, and turbo output warnings, with no failures.
