# Vendo public docs: information architecture

Plan for the public developer docs site on Mintlify. Content is written by Codex agents per group, orchestrated from the `yousefh409/docs` worktree.

## Decisions (Yousef, 2026-07-05)

- Platform: Mintlify free Starter plan. Native `docs.json` theming from Brand.md; custom CSS and preview deployments wait for the Pro upgrade.
- Naming: rename PR #50 is merged; all docs are natively Vendo / `@vendoai/*`. Zero occurrences of "flowlet" in public pages.
- Install honesty: write installs as if packages are published (`npm i @vendoai/next`). Site goes live only when ENG-198 npm publish lands; until then it stays preview/unlisted.
- Demos: excluded from v1. Public docs reference `examples/node` and generic snippets only. The Gmail clone is internal-only permanently (unlicensed upstream).

- Site source lives in `docs-site/` in this monorepo (Yousef, 2026-07-05): docs PRs travel with code changes and Codex verifies snippets against the workspace. Mintlify's GitHub app points at the subfolder.
- Name collision resolved (Yousef, 2026-07-05): the old Vendo SDK product (runvendo/vendo-docs, Fumadocs site at docs.vendo.run) is defunct. These docs take over docs.vendo.run when they go live; the old site gets archived. Platform stays Mintlify despite the existing Fumadocs infra.

## Page tree

Tab: Documentation.

### Getting started
- **Introduction** (landing): what Vendo is, the one-paragraph pitch (embedded agent, acts through your API as the signed-in user, generated UI in a sandboxed brand-native surface, zero infra, BYO keys), hero screenshot/gif. Sources: `docs/PRD.md`, `README.md`.
- **Quickstart (Next.js)**: `vendo init` codemod path, one key, first generated view, under ten minutes. Source: `docs/quickstart.md`.
- **Quickstart (any Node server)**: `@vendoai/server` fetch handler, Node/Express/Hono mounts, serving sandbox assets. Sources: quickstart "Not using Next.js?", `examples/node`.
- **Capability keys**: the additive key ladder, provider precedence, `VENDO_MODEL`. Source: quickstart.

### Concepts
- **Architecture**: where things run (host server, user's browser, sandbox iframe), no Vendo cloud in this path. Public-safe summary of the platform spec's seams. Source: `docs/superpowers/specs/2026-07-01-flowlet-platform-architecture-design.md` (distilled, not linked).
- **Generated UI and the sandbox**: `render_view`, flat node tree (primitives, host catalog, generated code), egress-jailed iframe, host-rendered Connect card exception. Sources: `README.md`, F3/F4 specs.
- **Tools and safety**: client-executed tools on the user's own session, fail-closed `mutating` annotations, approval policy and consent surfaces. Sources: quickstart, ENG-193 spec.
- **How prompts are assembled**: platform behavioral core plus host identity/extras, guardrails win on conflict, tool-output capping. Source: quickstart "Customizing".

### Connect your app
- **The vendo init codemod**: what it writes, `.vendo/` as the reviewable source of truth, re-running, `--force`, what it skips and why. Sources: quickstart, `packages/vendo-cli`.
- **Tools from your API**: `tools.json`, OpenAPI extraction vs route scan, relaxing annotations by hand. Sources: quickstart, ENG-197 spec.
- **Host components**: exposing real components, descriptor plus impl pairs, build step. Source: `docs/host-components.md`.
- **Theming**: extracted theme, brand tokens, the css option for sandbox styling. Sources: `docs/host-components.md`, brand-tier work.
- **Custom instructions**: `instructions`, `instructionsExtra`, function form with `ctx.toolSummary`. Source: quickstart.

### Capabilities
- **Integrations**: Composio catalog, OAuth connect cards, what a missing key hides. Sources: quickstart, integration specs.
- **MCP servers**: code and `.vendo/mcp.json` config, env interpolation, limits (HTTP transport, static headers, tools only), annotation-driven approvals. Source: quickstart MCP section.
- **Automations**: schedules and triggers, versions, per-tool grants, run history, editing and remix. Sources: ENG-188 spec, remix/persistence specs, `docs/persistence-and-deploy.md`.
- **Saved views**: the library, live refresh semantics, undo. Source: ENG-183 spec.
- **Voice**: realtime voice, OpenAI key requirement, current maturity. Source: ENG-185 spec.

### Deploy and operate
- **Persistence**: durable by default (PGlite at `.vendo/data`), `DATABASE_URL` Postgres, `storage: false`. Source: `docs/persistence-and-deploy.md`.
- **Deploying safely**: local-only default, `principal` resolver as the production gate, `VENDO_ALLOW_REMOTE` escape hatch, single-tenant single-process posture. Source: quickstart "Deploying".
- **Scheduler and webhooks**: instrumentation boot, serverless modes, `/tick`, Composio webhook ingress. Source: `docs/persistence-and-deploy.md`.
- **Telemetry**: what is collected, opt-out. Source: `TELEMETRY.md`.
- **Troubleshooting**: quickstart list plus accumulated gotchas.

### Reference
- **Handler options**: every `createVendoHandler` / `createVendoFetchHandler` option, verified against types.
- **@vendoai/server API**: exports, `toNodeHandler`.
- **CLI**: `vendo init` flags, `publish` status.
- **.vendo/ directory**: every file the codemod writes and what edits are supported.
- **HTTP routes**: the catch-all endpoints the handler serves.
- **Environment variables**: all `VENDO_*` plus provider and Composio keys.

Deferred past v1: an API Reference tab (Mintlify playground from an OpenAPI spec of the handler routes), changelog tab, demo walkthroughs.

## v1 cut

Launch-blocking: all of Getting started, all of Concepts, Connect your app, Deploy and operate, and Reference (handler options, CLI, .vendo/, env vars). Wave 2: Capabilities pages beyond Integrations and Automations (Voice ships with an explicit maturity note or waits), HTTP routes reference, API tab.

## Execution

1. Scaffold the site: `docs.json` themed from Brand.md (porcelain/ink/ultramarine, Inter/Newsreader, wordmark), nav matching this tree, placeholder pages.
2. Fan out one Codex task per group, each given this file plus the source pointers above. Pages must be verified against workspace code: option names against types, commands run where feasible.
3. Verification gate per PR: `mint dev` renders, broken-link check, naming audit (no "flowlet" in public pages), snippets consistent with current package APIs.
4. Yousef reviews the themed site visually before anything goes live (UI/UX gate), and again at launch when ENG-198 publishes packages.
