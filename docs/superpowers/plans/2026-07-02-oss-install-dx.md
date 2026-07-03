# OSS Install DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline execution chosen — autonomous session, warm context). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Flowlet installable on a fresh Next.js app with one command (`npx flowlet init`) and one key (`ANTHROPIC_API_KEY`), proven end-to-end in a real browser.

**Architecture:** A new `@flowlet/next` package holds everything demo-bank hand-rolls: a server `createFlowletHandler()` (one catch-all route: chat, action, integrations, capabilities, tick) and a client `<FlowletRoot>` (provider + shell + overlay + generic sandbox stage). The CLI's `flowlet init` becomes a codemod that writes the route, wraps the layout, drops `.env.example`, copies sandbox assets, and runs the existing extractor. Keys are capability-additive: Anthropic = chat+genUI, +Composio = integrations, +OpenAI = voice flag only.

**Tech stack:** Next.js 16 App Router (web `Request`/`Response`, no `next` import needed in the handler), existing `@flowlet/*` packages, zod, vitest.

**Model (locked by Yousef, not revisitable here):** codemod not scaffold-only, zero-config handler reading `.env` + `.flowlet/`, capability-additive keys, voice seam only (ENG-185 owns voice UX).

---

## Decisions taken inside the locked model

1. **New package `packages/flowlet-next`** (task offered this or a runtime subpath). Reasons: the handler reads `.flowlet/` from disk (`node:fs`) and assembles client-UI concerns — putting it in `@flowlet/runtime` would erode the portable-runtime boundary the dependency-guard test protects. Runtime stays untouched.
2. **Client wrapper is package code, not generated code.** The codemod writes ~3 tiny reviewable files that import `@flowlet/next`; all real wiring (provider, shell, overlay, sandbox stage, capability gating) lives in the package where it's testable and upgradeable. Host app's only new dependency: `@flowlet/next`.
3. **No new visual design.** The embed surface composes existing, shipped shell elements (`FlowletOverlay` with its built-in launcher, `ApprovalCard`, theme vars from `.flowlet/theme.json`). PR flags the composed default surface for Yousef's visual review anyway.
4. **Manifest→host-tool converter lives in `@flowlet/next`** (isomorphic module, both entries use it). Core's frozen contracts are not touched. Convention per `.flowlet/README.md`: inputSchema props matching `{path}` template names are path params, `body` prop is the request body, the rest are query params; `readOnlyHint = !mutating`, `destructiveHint = dangerous`.
5. **Default security posture:** zero-config = local-only requests (same guard demo-bank uses), because the handler holds real keys and default policy auto-allows reads. Deploying requires passing a `principal` resolver (its `null` = 403) — documented honestly in the quickstart.
6. **Stage-action approvals get a server-side HMAC token** (per-process secret, binds action+payload) instead of demo-bank's trusted `approved:true` re-POST — this is the handler's *default* policy surface, so demo-grade trust is not acceptable.
7. **Fresh-app proof uses `pnpm pack` tarballs + npm overrides** (packages aren't on npm yet; publish is ENG-198). The quickstart tells the npm story with an explicit "not yet published" note. Known publish blocker to report: `@flowlet/shell`'s `fluidkit` is a relative `file:` tarball dep.

## Endpoints (`app/api/flowlet/[...path]/route.ts`, runtime nodejs)

- `POST /chat` — streamed agent turn. Agent cache keyed by connected-toolkits + world generation (+ host `cacheKey` option), exactly demo-bank's ingestion-cache semantics.
- `POST /action` — sandbox `flowlet.dispatch` through the composed policy; approval via HMAC token round-trip.
- `GET|POST /integrations` — Composio catalog/connect/status/disconnect (in-memory connections store). Without `COMPOSIO_API_KEY`: GET returns `{integrations: [], enabled: false}`; POST 503. No errors, UI hides the rail.
- `GET /capabilities` — `{chat, integrations, voice}` from env-key presence. Client gates on this.
- `POST /tick` — drives the automations scheduler (in-memory world: store + scheduler + authoring tools over the host's server tools).
- Unknown path → 404 JSON.

Options (zod-validated, all optional): `model`, `instructions`/`instructionsExtra`, `policy`, `tools` (ToolSet or factory), `toolkits` (list or fn), `components`, `hostTools` override, `flowletDir`, `principal(req)`, `cacheKey()`, `integrations` catalog, `automations` on/off. Zero-config default covers the acceptance bar.

Default policy: host tools (client-executed) → annotation policy; `render_view`/`request_connect`/automation reads → allow; Composio names → whole-segment verb heuristic (write verbs win); unknown → approve (fail-safe). Same shape as demoPolicy, generic.

## Tasks

### Task 1 — `@flowlet/next` scaffold
Create `packages/flowlet-next` (two exports: `.` server, `./client`), tsconfig matching sibling packages, vitest. Verify `pnpm build` picks it up via turbo. Commit.

### Task 2 — config, capabilities, manifest loading (TDD)
Server modules: env capability detection; `.flowlet/` loader (theme.json → BrandTokens via existing schema, tools.json → manifest schema); the ManifestTool→HostToolDefinition converter (isomorphic file). Tests: converter param/body/annotation mapping, missing-`.flowlet/` behavior (empty tools + default brand, warn once), capability flags. Commit.

### Task 3 — default policy (TDD)
Generic policy module with the demoPolicy behaviors minus demo tool names. Tests mirror demo-bank's policy tests plus fail-safe cases. Commit.

### Task 4 — chat endpoint + agent assembly (TDD)
Agent factory: anthropic model from env (`FLOWLET_MODEL` override), instructions built from brand guidance + prewired catalog + host-component catalog (from options) + automation instructions; Composio ingestion only for connected toolkits; keyed agent cache. Chat handler: message validation, dangling input-* repair is engine-owned (verified), `hostToolset` from converted manifest, principal/local guard. Tests with stub model. Commit.

### Task 5 — action endpoint with approval tokens (TDD)
Policy-evaluated dispatch over the handler's server tools; `needsApproval` returns signed token; execution requires it. Tests: allow path, approve round-trip, forged/mismatched token rejected, unknown action 404. Commit.

### Task 6 — integrations endpoints + connections store (TDD)
Generic port of demo-bank's store + routes, catalog from options (default = demo-bank's list), everything no-op/disabled without the key. Tests. Commit.

### Task 7 — automations world + tick (TDD)
Generic assembly of InMemoryAutomationStore + InProcessScheduler + authoring tools registered over the host's server tools; generation feeds the agent cache key. Tests: authoring tools present, tick fires due schedule with stub runner. Commit.

### Task 8 — router: `createFlowletHandler()` (TDD)
Compose 2–7 behind `{GET, POST}` with path dispatch + zod options validation. Tests: routing table, 404, options rejection. Commit.

### Task 9 — client `<FlowletRoot>` (`@flowlet/next/client`)
Props: `{theme, tools, children, productName?, threadId?, suggestions?, greeting?}`. Wires FlowletProvider (DefaultChatTransport → `/api/flowlet/chat`, hostTools from converter) + FlowletThemeProvider + FlowletShellProvider (generic SandboxStage renderNode fetching `/flowlet/*.js`, runQuery through `/action` restricted to `mutating:false` manifest tools, integrations seam hitting `/integrations` only when capabilities allow, webStorage store) + FlowletOverlay. jsdom smoke tests (mount, capability gating). Commit.

### Task 10 — CLI codemod (TDD on fixtures)
Extend `flowlet init` for `framework === "next"` + App Router:
- write `app/api/flowlet/[...path]/route.ts` (or `src/app/...`), a small client `flowlet-root.tsx` importing `@flowlet/next/client` + the two `.flowlet` JSON files, `.env.example` (three keys, capability ladder documented);
- wrap root layout's `{children}` with the generated root — TypeScript-AST-based, idempotent, respects existing providers; **any uncertainty → leave the file untouched and print exact manual instructions** (never break existing code);
- copy sandbox assets (`react-runtime.js`, catalog `components-sandbox.js`) into `public/flowlet/` — bundled into the CLI package at build time;
- add `@flowlet/next` to package.json deps (no install run; instruct);
- run the existing extractor as today; `--force` semantics preserved.
Read `node_modules/next/dist/docs` conventions first (Next 16 differs from training data). Fixture tests: fresh create-next-app layout (js+ts, with/without `src/`), layout with existing providers, already-initialized (idempotent re-run), unrecognizable layout (fail-open). Commit.

### Task 11 — migrate demo-bank onto the handler
Replace chat/action/integrations routes with one catch-all using options (`tools` factory merging demoTools + automations authoring tools, `toolkits` from connections store, `cacheKey` from automations generation, demo policy, maple components, principal + FLOWLET_DEMO_PUBLIC parity). Poll/reset routes stay custom. Full demo test suite + browser check of the demo beats (chat, generated view, connect rail). If the handler can't cover a real need cleanly, extend the handler (that's the point of migrating) — never fork behavior. Commit.

### Task 12 — fresh-app e2e proof (the acceptance bar)
Scripted in `scripts/` or scratch: `create-next-app` in scratchpad → pack all workspace tarballs (+ vendored fluidkit) → install with overrides → `npx flowlet init .` → paste one Anthropic key (Infisical) → `npm run dev` → browser-verify chat answers AND a generated view renders; screenshots; record wall-clock dev effort (<10 min bar). Also re-verify demo-bank beats. This is the gate for everything upstream.

### Task 13 — docs/quickstart.md
The install story exactly as proven: one command, one key, capability ladder, deploy note (principal resolver), "packages not yet on npm" honesty, troubleshooting (missing key, missing sandbox assets). Sync CLAUDE.md commands section.

### Task 14 — ship
verification-before-completion (build/test/typecheck/lint + e2e evidence) → PR with screenshots → dual-review (fresh codex + fresh Opus, briefed to attack codemod edit safety on real-world layouts, key handling, handler default policy surface) → triage documented in PR → self-merge on standing authority → Linear/orca comment updates.

## Risks / watchpoints
- Next 16 conventions differ from training data — read the shipped docs before writing route/layout code.
- React 19 peer ranges already OK across packages; showcase's React-18 pin was app-local.
- Turbo build order: CLI build must depend on `@flowlet/components` `build:sandbox` + stage shim artifacts.
- Dependency-guard test must stay green — runtime is not modified.
- `.flowlet/tools.json` on a fresh app is all-mutating (fail-closed extractor); chat+genUI must work with zero host tools.
