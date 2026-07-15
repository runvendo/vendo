# ENG-276 — Real-client apps-ride-along e2e, including the live-Claude leg

Linear: https://linear.app/runvendo/issue/ENG-276 · Project spec: `/Users/yousefh/orca/workspaces/flowlet/mcp-door/docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream B).

## Context

You are executing one issue of Vendo's "Ship through the MCP door" project. Read `docs/contracts/00-overview.md` first, then `docs/contracts/10-mcp.md` §4 and §6. The contract mandates an e2e that drives `vendo_apps_open` and asserts the shim actually renders via `_meta.ui.resourceUri` — today only SDK-level assertions exist.

What already exists (build on it, don't duplicate):

- `fixtures/mcp-e2e/src/apps-ride-along.e2e.test.ts` — real MCP SDK client against a real door over HTTP: asserts `_meta.ui.resourceUri` on descriptors, format-tagged payload from `vendo_apps_open`, shim resource served with the MCP Apps mimeType, guarded `vendo_apps_call` with dual audit rows. No rendering.
- `fixtures/mcp-e2e/src/live-claude.e2e.test.ts` — the env-gated live-leg pattern (`VENDO_LIVE_MCP=1`): serves a door on a fixed port, prints operator instructions, self-asserts by polling the audit table.
- `fixtures/mcp-e2e/src/harness.ts` + `support.ts` — stack boot + SDK connect helpers.
- `fixtures/integration-browser` — Playwright harness that boots a REAL `createVendo` host over HTTP (see its `harness/` + `journey.spec.ts` for patterns).

The shim itself: `packages/ui/src/tree/mcp-shim/entry.tsx`, bundled into `packages/mcp/src/shim/shim-html.gen.ts`, speaks `@modelcontextprotocol/ext-apps` `App` + `PostMessageTransport` to its parent frame.

## Deliverable 1 — browser-driven host-harness leg (the core of this issue)

A Playwright e2e (likely a new spec in `fixtures/integration-browser` or a sibling `mcp-apps` fixture — your call, follow repo layering) that plays the HOST side of MCP Apps against a real door:

- Boot the fixture host with the door enabled; fetch the shim resource exactly the way a client would (resources/read of `ui://vendo/tree-shim.html`).
- Load the shim HTML in an iframe and implement the host side of the ext-apps protocol in the page (the `@modelcontextprotocol/ext-apps` package exports the host API — investigate what the host half needs: deliver tool input/result for `vendo_apps_open`, proxy `callServerTool` to the real door over HTTP).
- Assert: the fixture app's tree actually RENDERS in the shim DOM (not just payload equality); a click on an action element round-trips `vendo_apps_call` through the door and updates; a destructive ref parks (pending-approval surfaces in the shim).
- Screenshot artifacts of the rendered shim for the PR.

## Deliverable 2 — live-Claude leg (env-gated)

Pattern on `live-claude.e2e.test.ts`: an env-gated test (`VENDO_LIVE_MCP_APPS=1` or reuse the existing flag — your call) that serves a door with apps enabled on a fixed port, prints operator instructions (connect from Claude, open the fixture app), and self-asserts door-side: audit/evidence of `vendo_apps_open` (venue=mcp) plus the shim resource being read. It must skip cleanly by default so CI stays green. Do NOT block on a deployed public host — this leg runs against a local door with the operator's Claude (same as the existing live test).

## Bar

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green (new Playwright leg wired the same way integration-browser is in CI).
- Branch `yousef/eng-276-real-client-apps-ride-along-e2e-including-the-live-claude`, PR to `main`, never commit to main.
- PR includes screenshots of the rendered shim from the harness run.
- Stay out of `packages/ui/src/tree/mcp-shim/entry.tsx` and `packages/mcp/src/door.ts` if you can — a parallel worker (ENG-275) is refactoring the shim internals; consume public behavior only, and if you hit a genuine blocker there, escalate instead of editing.
