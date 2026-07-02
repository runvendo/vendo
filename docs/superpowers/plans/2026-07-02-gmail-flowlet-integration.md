# Gmail Clone Flowlet Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Flowlet in embedded mode into the Gmail clone (`apps/gmail`) with all three F5 shell surfaces (page, Cmd+K overlay, slot), the app's own mail API as approval-gated agent tools, an extractor-produced `.flowlet/`, and 1–2 registered host components — verified live in a real browser.

**Architecture:** The clone gains a small Express backend that owns seeded mail state and hosts the Flowlet runtime (chat + action routes), exactly mirroring demo-bank's embedded topology; the CRA frontend proxies `/api` to it. The existing Redux views are re-pointed at the API so agent actions are visible in the app. Surfaces mount through one shared provider stack (`FlowletProvider` + `FlowletShellProvider`), generated UI renders in the egress-jailed sandbox stage with a merged prewired+host component bundle.

**Tech Stack:** CRA 5 (react-scripts) upgraded to React 18, Express + tsx for the backend, `@flowlet/{core,react,shell,components,runtime,stage}` workspace packages, `flowlet-cli` extractor, Playwright/Chrome for live verification.

---

## Locked decisions (and why)

1. **`apps/gmail` joins the pnpm workspace; React 17 → 18.** `@flowlet/react`/`@flowlet/shell` require React ≥18 and are `workspace:*` packages — consuming them from an npm-managed, workspace-excluded app is not workable. This reverses PR #24's "keep it out of the workspace" note; called out in the PR. The npm `package-lock.json` is removed.
2. **Backend is a standalone Express server at `apps/gmail/server/` run via `tsx`.** The clone has no backend and embedded mode means the runtime runs in the app's own backend. Plain Node cannot load the tsc-built `@flowlet/*` dists (extensionless ESM imports — known ENG-197 gotcha); `tsx` resolves them (verified in this worktree). CRA dev server proxies `/api` → `localhost:3198`; app stays at `localhost:3199`.
3. **The server owns mail state.** In-memory store seeded with the believable 2026 inbox (full bodies added). The Redux views (inbox/starred/sent) fetch from the API and mutate through it, with a light poll so agent-made changes appear in the UI. Without this, agent actions through the API would be invisible in the app.
4. **A minimal read view is added** (click an email → read pane, mark-read). Named allowed by the task; needed so "act on real mail" is demonstrable. Search-bar filtering and other cosmetic gaps stay untouched (no gold-plating) — search exists as an agent tool instead.
5. **Host-API tools via the ENG-202 path:** hand-authored `apps/gmail/openapi.json` → `openApiToHostTools` feeds both the server (caller seam, no execute) and the browser (client executor). Policy = `annotationPolicy` for client tools + allow-list for in-process tools; sends/mutations pause on the approval card.
6. **Interesting mail actions as tools:** list/search/get (reads, free), send/reply, archive, star, label, mark-read (mutating, approval-gated).
7. **Extractor is run for real** on the app (`flowlet init`) and its output reported honestly in a fidelity findings doc; `.flowlet/` is then hand-fixed. Expected weak spots: theme (styled-components, no Tailwind → defaults), components (JSX not TSX), tools (OpenAPI path should be deterministic once the spec exists).
8. **Host components (1–2)** follow the repo-real 3-file path (`descriptor.ts` + `impl.tsx` wrapper + `entry.ts` filling `window.__FLOWLET_HOST__`). The gmail entry also imports `prewiredImpls` from `@flowlet/components` so ONE merged sandbox bundle serves the stage (the stage loads a single `bundleSource`). Wrappers must avoid remote images (sandbox CSP blocks gstatic icons) — reuse the app's styled-components with inline SVG.
   *Note for orchestrator:* the task brief references `docs/host-components.md` + `bindHostImpl`/`installFlowletHost` — none of these exist on main; the `.flowlet/components` descriptor/impl/entry pattern is the actual seam. Flagged rather than invented.
9. **Surfaces (placement = proposal, Yousef gates):**
   - PAGE: new route `/flowlet` rendering a full-height `FlowletThread`, nav item in the sidebar (Inbox/Starred/Sent list).
   - OVERLAY: `FlowletOverlay` with Cmd/Ctrl+K mounted app-wide.
   - SLOT: `FlowletSlot` card at the top of the inbox list (its own thread id).
10. **No Composio** for this demo — the app's own API is the story; `composio` config omitted (it is optional in `createFlowletAgent`).
11. **No shared-package edits.** Anything that needs one is surfaced to the orchestrator instead.

## The demo beat (acceptance bar — orchestrator scope update, 2026-07-02)

User types, verbatim: *"Turn my unread emails into Tinder: swipe left to delete, swipe right to reply for me. Swipe up to send it to my team's Slack with a quick summary."* The agent must generate a working, Gmail-themed swipe UI (Tier-2.5 generated component, Pointer-Events gestures) over the clone's real unread emails, where each gesture dispatches a governed action through the sandbox bridge:

- **left = delete** that email (host mail store, acting as the user) — approval-gated
- **right = reply-for-me** — the server drafts the reply with the model, then sends it — approval-gated
- **up = REAL Slack post** — server writes a short summary with the model and posts it via the verified Composio REST execute path (`SLACK_CHAT_POST_MESSAGE`, userId `flowlet-demo`, #general `C09U93V4ER3`, `COMPOSIO_API_KEY` via Infisical project b366cac7/dev) — approval-gated

Implications folded into tasks below: the action route must EXECUTE approval-gated writes (demo-bank's never does), so approvals get a server-issued one-time token bound to action+payload (the trusted-re-POST hole dual-review will attack); in-process tools `list_unread_messages` (read, allowed) + `delete_message` + `send_reply` + `slack_summary` (gated); system prompt teaches the dispatch names, payload shapes, and swipe-UI generation; seed guarantees ~6-8 believable unread emails. Placement approval is delegated to the orchestrator (Yousef away); self-merge after green dual-review is claimed authorized — flagged against the repo standing rule at merge time.

## Known gotchas to respect

- Chat streaming must survive the CRA dev-server proxy (compression can buffer SSE). Verify live; fix with `no-transform`/proxy config in `setupProxy.js` if buffered.
- Sandbox blocks all remote loads: no gstatic/FontAwesome in host component wrappers or generated UI.
- Demo-bank's local-only principal guard is kept (403 off-localhost unless opted in).
- One agent instance can be a singleton here (no Composio toolkit re-keying needed).
- `pnpm overrides` pins `@types/react` 19 repo-wide — irrelevant to the JS app, but don't add TS React types to it.
- Turbo runs `build`/`test` scripts in every workspace package: gmail's `test` must be non-watch (`CI=true`), and its CRA build must not break `pnpm build`.

---

### Task 1: Workspace migration + React 18

**Files:** `pnpm-workspace.yaml` (drop `!apps/gmail`), `apps/gmail/package.json` (react 18, scripts, name `gmail-demo`), `apps/gmail/src/index.js` (createRoot), delete `apps/gmail/package-lock.json` + CRA test boilerplate, `apps/gmail/README.md` update.

- [x] Move the app into the workspace, upgrade React, fix the entry point
- [x] `pnpm install` clean; app boots visually unchanged at :3199 under pnpm
- [x] Commit

### Task 2: Mail backend (API + seed + OpenAPI)

**Files:** `apps/gmail/server/{store,seed,api,index}.ts`, `apps/gmail/server/__tests__/`, `apps/gmail/openapi.json`, `apps/gmail/src/setupProxy.js`, deps (express, tsx, vitest).

- [x] TDD the store: folders, search, star, archive, label, mark-read, send (in-memory, reseedable)
- [x] Express routes matching `openapi.json` exactly; author the spec with real annotations (reads `readOnlyHint`, sends/mutations mutating)
- [x] Vitest green (`pnpm --filter gmail-demo test`)
- [x] Commit

### Task 3: Frontend re-pointed at the API + read view

**Files:** `apps/gmail/src/redux/mail/` (new slice), edits to paginate/starred/outbox consumers (`inbox-content`, `starred`, `sent`, `message-template`, `composeMessage`), new `message-view` component + route, `App.js`.

- [x] Inbox/starred/sent render from `GET /api/messages`; star/send go through the API; light poll keeps UI fresh
- [x] Read view opens a message (marks read) in keeping with existing styles
- [x] Live check in browser: views work, reload persists (server state)
- [x] Commit

### Task 4: Embedded Flowlet server side

**Files:** `apps/gmail/server/flowlet/{agent,policy,host-tools,tools,principal,chat,action}.ts`, route wiring in `server/index.ts`, tests.

- [x] Agent factory: anthropic model + instructions (component catalog + mail capabilities + render_view guidance, adapted from demo-bank), no Composio
- [x] Policy: annotation-driven for client host tools; allow-list for `render_view`/in-process reads; fail-safe approve
- [x] `/api/flowlet/chat` (UIMessage stream over Express) + `/api/flowlet/action` (stage dispatch, approval handshake) with the local-only guard
- [x] Tests with a mock model; vitest green
- [x] Commit

### Task 5: Flowlet client root + sandbox pipeline

**Files:** `apps/gmail/src/flowlet/{FlowletRoot,SandboxStage,render-node,run-query,brand}.jsx|js`, `apps/gmail/scripts/copy-flowlet-sandbox.mjs`, `predev`/`prebuild` scripts, root `demo:gmail` script.

- [x] Provider stack (transport → provider → theme → shell) with gmail brand tokens; shell styles imported
- [x] Sandbox assets built + copied (react shim + merged bundle); stage renders generated UI; actions hit `/api/flowlet/action`
- [x] Commit

### Task 6: Extractor run + fidelity report + host components

**Files:** `apps/gmail/.flowlet/**` (extractor output, then hand-fixed), `docs/superpowers/specs/2026-07-02-gmail-extraction-fidelity-findings.md`.

- [ ] Run `flowlet init apps/gmail` with ANTHROPIC_API_KEY; capture the run verbatim
- [ ] Write honest fidelity findings (theme/tools/components: what it got right, wrong, missed)
- [ ] Hand-fix `.flowlet/` to ground truth; register 1–2 host components (descriptor + sandbox-safe impl + entry merged with prewired)
- [ ] Rebuild sandbox bundle with host components included; verify a host component renders in a generated view
- [ ] Commit

### Task 7: The three surfaces

**Files:** `apps/gmail/src/pages/flowlet-page.jsx` + route + sidebar nav item, overlay mount in `App.js`, slot in `inbox-content`.

- [ ] PAGE at `/flowlet` (full-height thread, suggestions, saved flows)
- [ ] OVERLAY on Cmd/Ctrl+K anywhere
- [ ] SLOT at top of inbox (own thread id, pin/edit/remove)
- [ ] Commit

### Task 8: Live verification + placement proposal → PAUSE for Yousef

- [ ] Real-browser pass: chat turn on the page; overlay opens; slot pins a generated view; one mail action (e.g. reply-send or archive) through the approval card, visible in the app afterwards
- [ ] Screenshot every surface + the approval card; save under `docs/superpowers/specs/` assets
- [ ] Update worktree comment; present placement proposal + screenshots; STOP for UI/UX review

### Task 9: PR + dual review (after approval)

- [ ] Open PR (never merge); run self-serve dual-review (fresh codex exec + fresh Opus subagent); triage findings on the PR
