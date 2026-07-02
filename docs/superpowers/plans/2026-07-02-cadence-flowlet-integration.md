# Cadence Flowlet Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Embed Flowlet into the Cadence accounting demo (apps/demo-accounting) in embedded mode, delivering all three F5 shell surfaces — full agent page, Cmd+K overlay, and a dashboard slot — wired to Cadence's own API and components, verified live in a real browser.

**Architecture:** Mirror the demo-bank reference integration: one FlowletRoot client island wraps FlowletProvider (HTTP transport to an in-app agent route) + FlowletShellProvider (brand vars, web storage, reads-only query replay). The agent runs server-side in Cadence's own Next.js backend via @flowlet/runtime; Cadence's REST API becomes client-executed agent tools through the OpenAPI adapter (reads auto-allowed, writes approval-gated). Generated UI renders in the egress-jailed sandbox stage fed by an app-owned bundle that merges the prewired catalog with 1–2 registered Cadence host components.

**Tech Stack:** @flowlet/{runtime,react,shell,components,stage,core}, ai SDK + @ai-sdk/anthropic, Next.js 16 App Router, flowlet-cli extractor, Vite (sandbox bundle), Playwright/Chrome for live verification.

**Constraints:**
- Base off current main. Do NOT edit shared flowlet packages — surface needed changes to the orchestrator.
- The 3-file host-component developer path (hostComponent/bindHostImpl/installFlowletHost) only exists on the open brand-tier branch (PR #25). On main, the same capability is wired app-side via the stage's host-bundle contract; migrate to the blessed helpers during the coordinated rebase once #25 lands.
- Surface placement (nav position, slot location) is Yousef's call: propose with screenshots and PAUSE before opening the PR. Never merge.
- No Composio / external integrations in this app — Cadence's own API is the toolset. The agent needs only ANTHROPIC_API_KEY (via Infisical).

---

### Task 1: Extractor run (Cadence as first real extractor customer)

- [x] Build the workspace so flowlet-cli dist exists.
- [x] Run `flowlet init apps/demo-accounting` with the Anthropic key injected via Infisical.
- [x] Review everything it produced in `.flowlet/` (theme.json, tools.json, components/) against ground truth: globals.css design tokens, openapi.json, real components.
- [x] Record an honest extraction-fidelity report (what it got right, wrong, missed) in docs/superpowers/specs/, following the ENG-197 findings format.
- [x] Hand-fix the artifacts where wrong (theme values, tool annotations, wrapper quality) — `.flowlet/` is the reviewable source of truth.
- [x] Commit artifacts + fidelity report.

### Task 2: Dependencies and build wiring

- [x] Add the flowlet workspace packages + ai SDK deps to apps/demo-accounting.
- [x] Add predev/prebuild steps that build the React shim + sandbox bundle and copy them into public/flowlet/ (demo-bank pattern, but pointing at the app-owned merged bundle from Task 4).
- [x] Update root `demo:accounting` script to inject secrets via Infisical (agent needs the Anthropic key now); sync CLAUDE.md's command note.
- [x] Verify `pnpm install` + typecheck stay green.

### Task 3: Server side — agent, tools, policy, routes (TDD, demo-bank patterns)

- [x] `src/flowlet/brand.ts`: Cadence BrandTokens derived from the extracted theme.json, hand-verified against the real evergreen palette.
- [x] `src/flowlet/principal.ts`: fixed demo principal for Maya Alvarez (signed-in firm user fiction).
- [x] `src/flowlet/host-tools.ts`: openapi.json → host tool definitions via the core adapter, excluding the demo-control routes (reset/simulate) from the agent's toolset.
- [x] `src/flowlet/tools.ts`: small in-process read tools over the store (dashboard metrics, clients, one client's documents, deadlines, activity) so sandbox dispatch + saved-view refresh work server-side.
- [x] `src/flowlet/policy.ts`: annotation policy for client-executed host tools; explicit allow for render/in-process reads; fail-safe approve otherwise.
- [x] `src/flowlet/agent.ts`: createFlowletAgent with Cadence-specific instructions (practice-management capabilities, host component catalog, render_view guidance), no Composio.
- [x] `src/flowlet/chat-handler.ts` + `action-handler.ts`, and routes `api/flowlet/chat` + `api/flowlet/action` (local-only guard like demo-bank).
- [x] Unit tests per module mirroring demo-bank's test shapes; all green.

### Task 4: Host components (Cadence's own components in generated UI)

- [x] Pick 1–2 real components that read well in generated views (candidates: the stat tile and the document-status badge/progress) and register them: zod descriptor (source "host") + sandbox wrapper that restyles via inline styles on --flowlet-* tokens (Tailwind CSS does not cross the sandbox boundary).
- [x] App-owned sandbox entry: merge prewired impls + Cadence wrappers into the stage's host-bundle contract; vite config via the stage's host preset; build feeds Task 2's copy step.
- [x] Register descriptors everywhere the registry goes: provider/stage components prop and the agent prompt's HOST COMPONENTS section.
- [x] Tests: descriptor validity (name/schema), wrapper renders from schema-valid props, bundle builds.

### Task 5: Client surfaces — the three F5 elements

- [x] `components/flowlet/FlowletRoot.tsx`: shared provider root (transport, components registry incl. host descriptors, brand vars, web storage namespace "cadence-demo", reads-only runQuery).
- [x] `components/flowlet/SandboxStage.tsx` + `render-node.tsx`: sandbox render path with approval prompt wired to the action route.
- [x] OVERLAY: `components/flowlet/FlowletLayer.tsx` mounted in the root layout — invisible until Cmd/Ctrl+K, Cadence-appropriate suggestions.
- [x] PAGE: `/assistant` route — tabbed page surface (live chat + saved flowlets) inside the app shell; nav item added to the sidebar (placement = proposal for Yousef).
- [x] SLOT: a FlowletSlot card on the dashboard in its own thread (placement = proposal for Yousef).
- [x] Typecheck, lint, unit tests green.

### Task 6: Live browser verification (the gate that counts)

- [x] Run the app with secrets; verify in a real browser and screenshot each: (1) a chat turn on the /assistant page, (2) Cmd+K overlay opening + answering, (3) a generated view rendering in the dashboard slot, (4) one host-API write (e.g. send a client message chasing documents) pausing on the approval card and executing after approval, with the result visible in the Cadence UI.
- [x] Save screenshots under verification/cadence-integration/.
- [x] Fix whatever the live run surfaces; re-verify until all four pass.

### Task 7: UI/UX gate → PR → dual review

- [x] Present placement proposals (nav position for /assistant, slot location on dashboard) to Yousef with screenshots; PAUSE for his review.
- [x] After approval: open the PR (screenshots attached; note the PR #25 rebase dependency for host-component helpers), keep worktree comment updated.
- [x] Run the self-serve dual-review pipeline (fresh codex exec + fresh Opus subagent), triage findings on the PR. DO NOT merge — Yousef merges.
