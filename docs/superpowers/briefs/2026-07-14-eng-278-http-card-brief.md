# ENG-278 — http/rung-4 apps degrade gracefully over MCP (open-in-product card)

Linear: https://linear.app/runvendo/issue/ENG-278 · Project spec: `/Users/yousefh/orca/workspaces/flowlet/mcp-door/docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream B).

## Context

Read `docs/contracts/00-overview.md`, `docs/contracts/10-mcp.md` §4, `docs/contracts/06-apps.md` (open surface / rungs). Machine-served (http/rung-4) apps open as `{ kind: "http", url }` from `AppsPort.open`; the door maps that to a bare `{ url }` output (`packages/mcp/src/door.ts`, `#executeAppsTool`, ~line 391). The shim's `ontoolresult` requires a format-tagged payload (`isPayload` in the shim source), so http apps render as **"Invalid app result"**. Locked v1 decision: do NOT render http apps inside host clients — show a branded open-in-product card linking out. Full http rendering is explicitly deferred.

## Deliverable

- The shim renders a clean open-in-product card for http opens: app name if available, host/product name, a prominent link (`target="_blank" rel="noopener noreferrer"`), themeable with the same CSS tokens the shim already uses. No more "Invalid app result" for this path.
- Decide the wire shape deliberately: either the door wraps http opens in an explicitly-tagged envelope the shim recognizes, or the shim recognizes the `{ url }` shape. Prefer an explicit, contract-visible shape — but keep the agent/text-client experience sensible (a text-only MCP client should still see something useful, e.g. the URL in the text content). Update `docs/contracts/10-mcp.md` §4 minimally if the shape changes; flag any contract edit prominently in the PR.
- Tests: shim unit tests for the card path (extend the ENG-275 suite you just built); an http fixture app in `fixtures/mcp-e2e` asserting the door output shape end-to-end.
- Browser-verified: screenshot of the rendered card (load the shim in a harness page) in the PR.

## Bar

- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green; regenerate `shim-html.gen.ts` after shim-source changes.
- Branch `yousef/eng-278-httprung-4-apps-degrade-gracefully-over-mcp` stacked ON TOP of your ENG-275 branch (same files); note the stack order in the PR description. Never commit to main.
