# ENG-275 — Shim runtime test suite + de-duplicated query resolution

Linear: https://linear.app/runvendo/issue/ENG-275 · Project spec: `/Users/yousefh/orca/workspaces/flowlet/mcp-door/docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream B).

## Context

You are executing one issue of Vendo's "Ship through the MCP door" project. Vendo is the embedded-agent devtool in this monorepo; `packages/mcp` is the MCP door, `packages/ui` holds the tree renderer and the MCP Apps shim. Read `docs/contracts/00-overview.md` first, then `docs/contracts/10-mcp.md` (§4 apps ride-along) and `docs/contracts/06-apps.md` + `08-ui.md` for query semantics.

The MCP Apps shim source is `packages/ui/src/tree/mcp-shim/entry.tsx` (231 lines). It is bundled by `packages/ui/scripts/build-mcp-app-shim.mjs` into the checked-in `packages/mcp/src/shim/shim-html.gen.ts` (regenerate with `pnpm --filter @vendoai/ui build:mcp-shim`). The door serves it as an MCP resource (`packages/mcp/src/door.ts` ~lines 266-280) and the ride-along tools live in `#executeAppsTool` (~line 381).

## Task 1 — runtime test suite (currently ~zero coverage)

Cover at minimum:

- `callApp` outcome mapping: `isError` → error outcome with joined text message; `structuredContent` preferred over text; text that parses as JSON vs raw text vs empty → null; a returned value that is already a `ToolOutcome` passes through, anything else wraps as `{status:"ok", output}`; thrown transport errors → error outcome.
- `decodePointer` / `setQueryData`: root path `""` (object required), nested container creation (object vs array chosen by next segment), numeric-only array segments, `~0`/`~1` unescaping, `__proto__`/`prototype`/`constructor` rejection, non-numeric array segment errors, immutability (structuredClone) of prior data.
- `resolveQueries`: per-query outcome fan-out; error/blocked/pending-approval → "Query … failed" notices; the `renderVersion` staleness guard (a newer render discards an older resolution).
- `ontoolinput` / `ontoolresult` flush logic: result-before-input and input-before-result orderings both render exactly once; non-payload `structuredContent` → the "Invalid app result" notice path.

`entry.tsx` runs side effects at import (DOM mount, bridge connect). Expect to refactor: extract the pure/testable logic into a sibling module (e.g. `shim-core.ts`) with `entry.tsx` as a thin bootstrap, keeping runtime behavior identical, then regenerate the shim bundle. Tests live in `packages/ui` following its existing vitest conventions — note fluidkit is stubbed package-wide via a vitest alias (see the ui vitest config); follow existing test file patterns (e.g. `packages/ui/src/tree/*.test.tsx`).

## Task 2 — de-duplicate query resolution

Today queries are resolved twice: the apps runtime resolves them server-side when `vendo_apps_open` executes (find the server-side resolution in `packages/apps` open path), and the shim re-resolves every `tree.queries` entry client-side via `vendo_apps_call` (extra round-trips, two implementations of the same pointer logic, drift risk). De-duplicate: resolution should happen once. Investigate which seam is cleanest — e.g. the door/apps strips already-resolved queries from the payload it returns over MCP, or marks resolved data so the shim skips them. Check whether client-side re-resolution is load-bearing for freshness anywhere (contracts 06/08/10, `docs/superpowers/specs/2026-07-11-app-format-design.md`) before choosing; document the decision and rationale in the PR description. If the contract text needs a minimal update to stay truthful, make it and flag it prominently in the PR.

## Bar

- TDD where practical: write failing tests first for the refactor-extracted logic.
- Regenerate `shim-html.gen.ts` after any `entry.tsx`/shim-source change; keep `fixtures/mcp-e2e` green.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` all green before the PR.
- Branch `yousef/eng-275-shim-runtime-test-suite-de-duplicated-query-resolution`, PR to `main`, never commit to main. PR description explains the de-dup seam decision.
- Two follow-on issues (ENG-278 http card, ENG-274 theme) will build on your branch — keep the extraction clean.
