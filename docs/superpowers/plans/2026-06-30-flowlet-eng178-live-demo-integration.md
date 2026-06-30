# ENG-178 — Flowlet × Maple "$87 Mystery" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan phase-by-phase. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Plan style:** Per the repo owner's rule, this plan is high-level — exact file paths, contracts described in prose, test intent, and commit points. No pasted implementation code.

**Goal:** Embed Flowlet into the Maple demo bank and make the 3-beat "$87 Mystery" run end-to-end on stage, with reliable fallbacks and one-touch reset.

**Architecture:** A server-only agent runs behind a new Next.js route in `apps/demo-bank`; the client talks to it over an ai-SDK HTTP transport; the shell (3 embed surfaces, shared thread) renders generated UI through the sandboxed stage. Beat 3 detection polls Maple's *existing* transactions API (drop-in layer, no backend hook).

**Tech stack:** Next.js 16 (App Router), `@flowlet/*` packages, `ai` SDK v6, `@composio/core` + `@composio/vercel`, `@ai-sdk/anthropic`, Infisical for secrets, Vitest.

**Verified preconditions (done):** Composio `flowlet-demo` Gmail + Slack ACTIVE; real receipt readable (6 Crunchwrap Supreme / 4 Nachos BellGrande / 2 Baja Blast = $87.00, ordered 1:14 AM); Slack post to `#general` works. Auth configs: Gmail `ac_C0WWr2sbI7AV`, Slack `ac_DT5-sR-LyeGz`. Secrets in Infisical project `b366cac7-1716-47a0-9617-f335500f6dee` env `dev`.

---

## File structure (what gets created/modified)

**`apps/demo-bank` (host):**
- `package.json` — add `@flowlet/*`, `ai`, `@ai-sdk/anthropic`, `@composio/core`, `@composio/vercel` deps.
- `src/flowlet/agent.ts` — construct the server-only `createFlowletAgent` (model + Composio gmail/slack + policy + system prompt). One responsibility: build the agent.
- `src/flowlet/principal.ts` — the fixed `flowlet-demo` principal + helper to read it.
- `src/flowlet/components.ts` — the registered component list (prewired + `TimeOfDayClock`) and the impls map shared by client + agent.
- `src/flowlet/rules-store.ts` — in-memory rules store (the natural-language guardrails) + match logic.
- `src/flowlet/poller.ts` — the late-night-order detector that reads Maple's existing transactions API and fires matched rules.
- `src/flowlet/slack.ts` — the Slack-fire action (real Composio send + canned fallback).
- `src/app/api/flowlet/chat/route.ts` — streams `agent.run()` over HTTP (the networked transport server side).
- `src/app/api/flowlet/integrations/route.ts` — live Composio connection status for the rail.
- `src/app/api/flowlet/rules/route.ts` — create/list active rules (used by the agent tool + UI confirmation).
- `src/app/api/flowlet/reset/route.ts` — re-seed Maple + clear rules/thread/poller → pristine state.
- `src/app/api/orders/route.ts` — Maple's first WRITE: place an order (inserts a late-night transaction).
- `src/app/order/page.tsx` — Maple "Order" page with a "Place order" button (Beat 3 live trigger).
- `src/components/flowlet/FlowletClient.tsx` — client wrapper: HTTP transport + `FlowletProvider` + `FlowletShellProvider` + `FlowletStage` wired into `renderNode`.
- `src/components/flowlet/HomeComposer.tsx` — docked composer surface on the home screen.
- `src/components/flowlet/CommandOverlay.tsx` — Cmd+K overlay surface (shared thread).
- `src/app/flowlet/page.tsx` — the Flowlet full-tab proof-point surface.
- `src/app/layout.tsx` / home `page.tsx` — mount the client wrapper, docked composer, overlay, reset shortcut.
- `scripts/composio-connect.mjs` — repo command to (re)generate Gmail/Slack authorize URLs for `flowlet-demo`.

**`packages/flowlet-components` (shared library):**
- `src/components/TimeOfDayClock/{descriptor.ts,impl.tsx}` — new prewired Beat-1 component.
- `src/descriptors.ts` / `src/impls.ts` / `src/index.ts` — register the new component.

**Root:**
- `package.json` — a `demo` script (start under Infisical) and `composio:connect` script.

---

## Phase 0 — Foundation: networked agent path

**Outcome:** typing in a bare embedded thread streams a real (mock-model) agent response into Maple.

### Task 0.1 — Add deps + env wiring
- **Files:** `apps/demo-bank/package.json`, root `package.json`.
- [ ] Add the Flowlet/ai/Composio/anthropic deps to demo-bank; add root `demo` + `composio:connect` scripts (run under `infisical run --projectId=… --env=dev`).
- [ ] Run `pnpm install`; verify the workspace still builds.
- [ ] Commit.

### Task 0.2 — Server-only agent factory
- **Files:** `src/flowlet/agent.ts`, `src/flowlet/principal.ts`, `src/flowlet/components.ts`.
- [ ] **Test first:** a unit test that builds the agent with a mock model + mock Composio client and asserts `run()` streams a `render_ui` result (mirror `examples/basic/src/realAgent.ts`). Run, watch it fail.
- [ ] Implement the factory: `createFlowletAgent({ model: anthropic(...), policy, composio: { config: { toolkits:['gmail','slack'] } }, instructions })`. Principal = `{ userId: 'flowlet-demo' }`. System prompt instructs the agent on the three beats and on surfacing the receipt's stated order time.
- [ ] Run the test; green. Commit.

### Task 0.3 — Chat route (HTTP transport, server side)
- **Files:** `src/app/api/flowlet/chat/route.ts`.
- [ ] **Test first:** a route test posting a messages array and asserting a streamed UIMessage response (offline mock model). Fail → implement → green.
- [ ] Implement: read messages, call `agent.run({ messages, tools:{}, principal, signal })`, return the stream as the HTTP response. Thread the principal here (the gap the in-process transport leaves).
- [ ] Commit.

### Task 0.4 — Client HTTP transport + bare embed
- **Files:** `src/components/flowlet/FlowletClient.tsx`.
- [ ] Wire an ai-SDK HTTP `ChatTransport` pointed at `/api/flowlet/chat` into `FlowletProvider`/`useFlowletChat` (replacing the in-process `createLocalTransport`).
- [ ] Mount a minimal thread on the home page; **visually verify** (browser screenshot) a typed message streams a response. Commit.

---

## Phase 1 — Embed the three surfaces

**Outcome:** home docked composer + Cmd+K overlay + Flowlet tab, all on one shared thread, with real generated UI rendering in the sandbox.

### Task 1.1 — FlowletStage into renderNode
- **Files:** `FlowletClient.tsx`.
- [ ] Wire `@flowlet/react`'s `FlowletStage` into the shell `FlowletShellProvider` `renderNode` (replace the non-production fallback). **Visually verify** a generated `ComponentNode` renders in the sandboxed iframe. Commit.

### Task 1.2 — Home docked composer
- **Files:** `src/components/flowlet/HomeComposer.tsx`, home `page.tsx`.
- [ ] Dock the composer at the bottom of Maple's real home; generated views render as inline cards above it and persist. **Visually verify.** Commit.

### Task 1.3 — Cmd+K overlay (shared thread)
- **Files:** `src/components/flowlet/CommandOverlay.tsx`, `layout.tsx`.
- [ ] Mount `FlowletOverlay` bound to the **same** provider/thread as the home composer (shared session). Verify a card made on home appears in the overlay. Commit.

### Task 1.4 — Flowlet tab (proof point)
- **Files:** `src/app/flowlet/page.tsx`, nav.
- [ ] Add a `FlowletPage` tab in Maple's nav. Verify it loads. Commit.

### Task 1.5 — Integrations rail = live Composio status
- **Files:** `src/app/api/flowlet/integrations/route.ts`, integrations seam wiring.
- [ ] **Test first** (mock Composio client → connected/disconnected). Implement the route reading real connection status for `flowlet-demo`; back the shell Integrations rail with it so Gmail + Slack show live "Connected" pills. **Visually verify.** Commit.

---

## Phase 2 — Beat 1: TimeOfDayClock

**Outcome:** "What did I spend when I should've been asleep?" → a 24-hour radial clock with the $87 @ 1:14 AM dot.

### Task 2.1 — TimeOfDayClock component
- **Files:** `packages/flowlet-components/src/components/TimeOfDayClock/{descriptor.ts,impl.tsx}`, registry files.
- [ ] **Test first:** descriptor schema + a render test asserting the 1:14 AM $87 dot and lit late-night hours from props. Fail → implement (radial 24h clock, late-night arc highlighted, labeled dot) → green.
- [ ] Register in `descriptors.ts`/`impls.ts`/`index.ts`; rebuild the package. Commit.

### Task 2.2 — Agent selects the clock for the Beat-1 question
- **Files:** `src/flowlet/agent.ts` (system prompt), `src/flowlet/components.ts`.
- [ ] Ensure the registered component + description steer the model to emit `render_ui` for `TimeOfDayClock` with the home transaction data. **Visually verify** the full path (type the question → clock renders with the dot). Commit.

---

## Phase 3 — Beat 2: Gmail receipt

**Outcome:** "Look at my Gmail, what was that $87?" → itemized receipt card from the real email.

### Task 3.1 — Composio connect script (repo command)
- **Files:** `scripts/composio-connect.mjs`, root `package.json`.
- [ ] Turn the verified throwaway into a real `pnpm composio:connect` command that prints Gmail + Slack authorize URLs for `flowlet-demo` and reports current connection status. (Already verified ACTIVE; this is for re-connect/rotate.) Commit.

### Task 3.2 — Agent reads Gmail + renders itemized card
- **Files:** `src/flowlet/agent.ts` (prompt), `components.ts`.
- [ ] Prompt the agent: on the "what was that charge" question, call Gmail (`GMAIL_FETCH_EMAILS` query doordash), parse the receipt, and `render_ui` an itemized `Card`/`List` using the real line items, surfacing the **order time 1:14 AM**.
- [ ] **Live-verify** (under Infisical) the real Gmail read renders the real itemization. Also an **offline** integration test with a canned email fixture. Commit.

---

## Phase 4 — Beat 3: snitch + live action

**Outcome:** "Put me on blast in Slack for late-night delivery" → rule set → place a live order → real Slack post to `#general`.

### Task 4.1 — Rules store + rule tool
- **Files:** `src/flowlet/rules-store.ts`, `src/app/api/flowlet/rules/route.ts`, agent tool.
- [ ] **Test first:** store add/list + match (late-night delivery txn matches; daytime/non-delivery doesn't). Fail → implement → green.
- [ ] Give the agent a `set_rule` in-process tool that writes a natural-language rule and returns a "Rule set" confirmation node. Commit.

### Task 4.2 — Maple Order page + write
- **Files:** `src/app/api/orders/route.ts`, `src/app/order/page.tsx`, store/transactions repo.
- [ ] **Test first:** POST order inserts a transaction (Maple's first write) with a late-night (1:14 AM-band) timestamp + DoorDash descriptor. Fail → implement → green.
- [ ] Build the Order page with a "Place order" button. **Visually verify** placing an order adds a transaction. Commit.

### Task 4.3 — Poller (drop-in detection)
- **Files:** `src/flowlet/poller.ts`.
- [ ] **Test first:** given a new late-night delivery row from the existing transactions API and an active rule, the poller fires once (idempotent across cycles via a fired-IDs set); no rule / daytime → no fire. Fail → implement (poll existing `/api/transactions`, diff, match, fire) → green. Commit.

### Task 4.4 — Slack fire + fallbacks
- **Files:** `src/flowlet/slack.ts`, poller wiring, a backstage inject control.
- [ ] **Test first:** fire calls Composio Slack send on match; on send failure, the canned fallback path still reports "posted" to the thread. Fail → implement → green.
- [ ] Add the backstage **inject** fallback (keyboard shortcut/hidden control) that creates the same late-night order so the poller path is identical.
- [ ] **Live-verify** end-to-end: set rule → place order → real `#general` post within ~2s. (Clean up any test posts.) Commit.

---

## Phase 5 — Reset & start

**Outcome:** one command to start; one keystroke to return to pristine state.

### Task 5.1 — Reset endpoint + shortcut
- **Files:** `src/app/api/flowlet/reset/route.ts`, client shortcut (⌘⇧R).
- [ ] **Test first:** reset re-seeds Maple, clears rules + poller fired-set; returns deterministic starting state. Fail → implement → green.
- [ ] Wire the ⌘⇧R shortcut (and a discreet button) to call it and reload the thread. **Visually verify** a full run then reset returns to the start line. Commit.

### Task 5.2 — `pnpm demo` start command + runbook
- **Files:** root `package.json`, `docs/superpowers/DEMO-RUNBOOK.md`.
- [ ] `pnpm demo` boots Maple+Flowlet under Infisical and opens the browser.
- [ ] Write the runbook: start command, the exact 3-beat stage script (1:14 AM copy), reset, fallbacks (inject + canned Slack), and re-connect via `pnpm composio:connect`. Commit.

---

## Phase 6 — Polish & deploy (tail)

### Task 6.1 — Animate the wow moments
- [ ] Add entrance/transition polish to the clock build, the receipt reveal, and the "Rule fired → posted" confirmation (Framer Motion, already in demo-bank). Keep it tasteful; **visually verify**. Commit.

### Task 6.2 — Deploy stage-ready URL
- [ ] Deploy demo-bank to a stage URL with the Infisical secrets configured server-side; smoke-test all three beats on the deployed instance. Local remains the primary stage path; deployed is the backup. Commit.

### Task 6.3 — F3b pull-in (when ENG-180 merges)
- [ ] When the F3b renderer lands on `main`, merge it and switch Beat 1 to true generated UI, keeping the prewired `TimeOfDayClock` as the stage fallback. Re-verify. Commit.

---

## Self-review notes
- **Spec coverage:** every spec section maps to a phase (networked path → P0; embed/3 surfaces/renderNode/integrations → P1; Beat 1 → P2; Beat 2 → P3; Beat 3 incl. rules/order/poller/slack/fallbacks → P4; reset/start → P5; polish/deploy/F3b → P6).
- **Principal threading** (spec gap #3) is handled in Task 0.3 (route passes `principal`), not left to the in-process transport.
- **Time:** all Beat-1/Beat-2 references use **1:14 AM** (verified receipt), consistent with the seed and script.
- **Fallbacks:** inject (Task 4.4) and canned Slack (Task 4.4) and prewired-clock (P2/6.3) all present.
