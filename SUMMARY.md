# Summary

Branch: `yousefh409/shell-polish`

Commits:
- `e2a7e750` Fix scoped overlay clear button layout
- `ab88f4c7` Add persistent VendoRemix affordance option

Changes:
- Reserved a right-side gutter in the scoped overlay header so `.fl-scope-clear` stays inline with the scope bar and no longer collides with `.fl-overlay-close`.
- Added `VendoRemix` prop `affordance?: "hover" | "always"` with the default unchanged at `"hover"`.
- Added CSS for `.fl-remix-btn[data-affordance="always"]` so the remix affordance is persistently visible when opted in.
- Updated VendoRemix tests for the default and always-visible affordance modes.

Verification:
- `pnpm test` in `packages/vendo-shell`: passed, 61 files and 331 tests.
- `pnpm build` in `packages/vendo-shell`: passed.
- `pnpm build` at repo root: passed, 19 of 19 turbo tasks.

Notes:
- The shell test suite still emits existing React `act(...)` and in-memory store warnings.
- The root build still emits existing bundle-size, Turbopack NFT trace, and turbo output warnings, with no failures.
