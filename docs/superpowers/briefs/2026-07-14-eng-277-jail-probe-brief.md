# ENG-277 (build leg) — Jail-sandbox probe stack + tunnel + runbook

Linear: https://linear.app/runvendo/issue/ENG-277 · Project spec: `/Users/yousefh/orca/workspaces/flowlet/mcp-door/docs/superpowers/specs/2026-07-14-mcp-door-design.md` (workstream B).

READ FIRST: `/Users/yousefh/orca/workspaces/flowlet/mcp-door-b-apps-ride-along/docs/superpowers/research/2026-07-14-eng-277-jail-sandbox-research.md` — the full research on what Claude/ChatGPT sandboxes permit and what the jail needs. Your job is to BUILD the probe; the orchestrator will drive the real Claude.ai/ChatGPT sessions and capture the verdict.

## Goal

A locally-served, publicly-tunneled MCP door I can add to Claude.ai (custom connector) and ChatGPT (developer mode) to answer, per client: (1) does `new Function` work inside the app iframe (inherited script-src carries `'unsafe-eval'`?), (2) do nested srcdoc iframes work (two levels), (3) does postMessage cross the nesting — plus (4) does Vendo's REAL shim render a generated component through the actual jail.

## Deliverable 1 — standalone capability probe (priority; decouples the CSP question from Vendo bugs)

A tiny standalone MCP server (or a mode of the fixture stack — your call, simplest wins) that serves ONE MCP Apps resource (`text/html;profile=mcp-app` via `_meta.ui.resourceUri`, same registration shape as `packages/mcp/src/door.ts` `appUiMeta()`) whose HTML self-tests and RENDERS results as large visible text (so a screenshot captures the verdict):

- `eval-direct`: `eval("1+1")` in the app iframe — pass/fail + the CSP violation message if any (listen for `securitypolicyviolation` events and display them).
- `new-function`: `new Function("return 1")()` — pass/fail.
- `srcdoc-1` and `srcdoc-2`: spawn an `<iframe srcdoc sandbox="allow-scripts">` which itself spawns another; each level posts a message up; display which levels reported in.
- `eval-in-jail`: `new Function` INSIDE the innermost srcdoc frame (this is the real question — CSP inheritance).
- Also display `document.baseURI`, and dump any CSP the page can observe (violation events carry `originalPolicy` — display it; this may be the first public capture of Claude's MCP-app script-src).

The probe tool should be callable with no arguments and named clearly, e.g. `vendo_jail_probe`.

## Deliverable 2 — the real Vendo leg

The same stack (or the fixtures/mcp-e2e `createStack` harness — see `fixtures/mcp-e2e/src/harness.ts`) serving the REAL door with an app whose payload includes a **generated component** so the actual jail path (`packages/ui/src/tree/jail/JailedComponent.tsx`) runs inside the shim. First verify locally (headless browser or manual) that the shim actually routes generated components to the jail at all — if it doesn't even work locally, report that as a finding immediately (escalate; don't sink time into fixing the pipeline, that's other issues' territory).

## Deliverable 3 — tunnel + runbook

- Public HTTPS exposure of the local door: prefer `cloudflared tunnel --url` (check if installed; else `npx`-runnable alternative). Verify through the tunnel: `.well-known` OAuth metadata resolves with the PUBLIC origin in its URLs (the door derives origins from the request — if the tunnel mangles Host/proto and metadata points at localhost, fix via the door's config/env or a forwarding header, and document it).
- OAuth: Claude.ai custom connectors will run the full OAuth flow. The fixture host app's interactive authorize (see `fixtures/mcp-e2e/src/authorize-interactive.e2e.test.ts` + `fixtures/host-app`) must be completable by a human in a browser: document the exact login/consent steps + credentials.
- Runbook at `docs/superpowers/briefs/eng-277-probe-runbook.md` IN YOUR WORKTREE: how to start the stack + tunnel (one command each), the public URL pattern, exact Claude.ai custom-connector add steps, exact ChatGPT developer-mode add steps, which tool to call, what each probe result looks like on pass/fail.
- Leave the stack + tunnel RUNNING in your terminal when done, and include the live public URL in your worker_done message.

## Bar

- Commit on your branch for reproducibility; NO PR to main needed — this is verification tooling (it may land later). Do not touch `packages/ui/src/tree/mcp-shim/entry.tsx` or `packages/mcp/src/door.ts` behavior (a parallel worker owns those files); config/env-level fixes only, or escalate.
- Keep probe code self-contained (new files under `fixtures/` or `scratch/`), so it can't conflict with the parallel shim work.
- If you hit a genuine door bug blocking the probe, escalate with details rather than patching shared files.
