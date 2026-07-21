# Docs revamp: new brand styling + journey IA with a two-path fork

Date: 2026-07-20
Status: approved by Yousef (interactive brainstorm, all four sections)
Scope: `docs-site/` only. No package, app, or CI changes beyond what verification requires.

## Goal

The public docs at docs.vendo.run are convoluted on every axis Yousef named: no obvious starting point, blurry group boundaries, rambling pages, and the old indigo brand. This revamp fixes all four at once:

1. Restyle the site to the new brand identity shipped in vendo-web PR #84 (violet, Onest, Geist Mono).
2. Restructure the IA into a journey with a visible two-path fork in the sidebar: bring your own agent (recommended) vs use Vendo's agent (beta).
3. Rewrite pages to a one-job-per-page standard and kill the duplication the page audit found.

Reference for the target feel: docs.context.dev, which is Mintlify theme `almond` with light custom CSS. We stay on Mintlify.

## Locked decisions

- Platform: Mintlify (current plan already applies custom CSS; verified on the live site).
- Depth: full restructure, reshaping existing content rather than re-deriving from code.
- Primary reader: human host developer. Coding agents keep their own lane.
- IA shape: journey groups, unnumbered so they age well.
- Two paths surfaced in the sidebar itself, not only on the Welcome page.
- Posture: Vendo's built-in agent is labeled beta everywhere it appears; docs recommend bringing your own agent for now.

## Visual identity

- Theme: `maple` to `almond` in docs.json.
- Colors: primary `#6c3bff`, light shade `#a78bfa`, dark-mode accent `#8b6bff`. Backgrounds white and `#0a0a0c`. Violet lives in accents, never surfaces. Light mode stays the default.
- Type: Onest for headings and body via docs.json fonts. Geist Mono for code, enforced in styles.css if the config does not expose a mono slot.
- Logo and favicon: the morph-blob lockup from vendo-web `public/brand/` replaces the old-brand SVGs in `docs-site/logo/`.
- styles.css: stays whisper intensity. Keeps the heading tracking rule, adds the PR #84 card shadow recipe (hairline plus soft violet-tinted drop) and violet link accents. No layout hacks; the theme owns layout.
- Welcome page: custom MDX homepage with a hero, a two-path chooser (BYO card tagged Recommended, Vendo-agent card tagged Beta), a coding-agents card, and a four-step journey strip. Approved mockup: two-path chooser layout from the brainstorm session.

## Information architecture

Principle: file paths stay where the page survives; only merged-away paths move. Mintlify nav groups are independent of directory layout, so regrouping costs no redirects. Killed paths each get a `redirects` entry in docs.json.

Nav (10 groups, ~42 pages):

1. Start here: Welcome (`index`, rewritten as the chooser), Install playbook (`install`, path pinned because `install.md` is a live agent surface), How Vendo works (`concepts/architecture`), Tools and safety (`concepts/tools-and-safety`).
2. Bring your own agent, group tag Recommended: Overview and tool pack (`existing-agents/index`), Quickstart: AI SDK (`existing-agents/ai-sdk`), Quickstart: Mastra (`existing-agents/mastra`), Embeds and envelopes (new page `existing-agents/embeds`, extracted from the embeds content currently triplicated across existing-agents/index, ui/components, and reference/hooks).
3. Use Vendo's agent, group tag Beta: Quickstart (`quickstart`, absorbs `quickstart-node` as framework tabs), UI surfaces (`ui/components`, absorbs `capabilities/voice` and `connect/tool-labels`).
4. Connect your app: vendo init (`connect/vendo-init`), API tools (`connect/api-tools`), Auth and act-as (`connect/act-as-presets`), Dev mode and models (`connect/dev-mode`).
5. Make it yours: Theming (`connect/theming`), Host components (`connect/host-components`), Prompts and instructions (`connect/instructions`, absorbs `concepts/prompts`).
6. Give it reach: Connected accounts (`capabilities/connected-accounts`, absorbs `capabilities/integrations`), MCP door (`capabilities/mcp`), MCP registry (`capabilities/mcp-registry`), Compound tools (`capabilities/compound-tools`), Generated UI and apps (`concepts/generated-ui`), In-client apps (`concepts/in-client-venue`).
7. Ship it: Production checklist (`deploy/deploying`, becomes a checklist hub), Persistence (`deploy/persistence`), Vendo Cloud (`deploy/vendo-cloud`), Principals and orgs (`deploy/principals-and-orgs`), Automations and webhooks (`deploy/scheduler-and-webhooks`), Telemetry (`deploy/telemetry`), Troubleshooting (`deploy/troubleshooting`).
8. For coding agents: `agents/index`, `agents/host-auth`, `agents/tools`, `agents/verify`. Structure unchanged.
9. Reference: `reference/handler-options`, `reference/server-api`, `reference/hooks`, `reference/cli`, `reference/dot-vendo`, `reference/http-routes`, `reference/environment-variables`.
10. Changelog: `changelog/overview`, untouched.

Killed paths, all redirected: `quickstart-node`, `capabilities/integrations`, `capabilities/voice`, `concepts/prompts`, `connect/tool-labels`.

## Beta posture

Every page and section specific to Vendo's built-in agent carries the Beta tag in nav and a standard callout: Vendo's built-in agent is in beta; most teams should bring their own agent for now. The BYO path is the recommended default in the Welcome chooser, quickstart ordering, and cross-links.

## Content standards (applied in PR 2)

- One job per page. Two to three sentence intro stating what the reader will have when done, code within the first screen.
- Concept, how-to, and reference never share a scroll. Deep wire detail moves to collapsed sections or the Reference group. First targets: quickstart (composition theory moves to How Vendo works) and MCP door (475 lines mixing all three).
- Journey and guide pages target 150 lines or less. Reference pages are exempt.
- One canonical home per repeated fact; every other mention is a line plus a link:
  - Cloud key fills unset adapter slots: Vendo Cloud (warning box). Currently restated about 7 times.
  - Model credential ladder: Dev mode and models.
  - init flags and what init writes: CLI reference. The vendo init page keeps the narrative.
  - Auth preset and env tables: Auth and act-as. agents/host-auth keeps detection signals only.
  - Error-code to HTTP status table: Troubleshooting.
  - policy `{}` semantics: Handler options.
- Voice: second person, direct, whisper brand. No marketing adjectives in body copy.
- Accuracy: code samples checked against current `@vendoai/*` packages where practical. The execution-venue enum inconsistency (`e2b|modal|custom` in http-routes vs `e2b|cloud|custom` in verify) is reconciled against code.

## Hard constraints

- `agents/verify`: path and every `{#E-XXX-NNN}` anchor byte-identical. They are live `fix_ref` targets emitted by `vendo doctor --json`.
- `reference/handler-options`: the options table is test-pinned. Structure survives verbatim; prose around it may improve.
- `install` keeps its path: `install.md` is a published agent surface.
- Changelog entries are never rewritten.
- No broken links: every killed path redirects, and `mint broken-links` passes.

## Shipping and verification

Two PRs, both branched off main:

- PR 1, visual layer + IA skeleton: docs.json (theme, tokens, fonts, nav, group tags, redirects), styles.css, logo and favicon assets, new Welcome page, file merges with content moved intact. The site is never broken in between.
- PR 2, content rewrite: page by page to the standards above, journey groups first.

Verification per PR:

- `mint dev` locally; before and after screenshots in the PR of Welcome plus one page per group, light and dark (repo rule: UI changes are browser-verified).
- `mint broken-links` clean.
- Diff guard: all verify anchors present and unchanged; handler-options table structurally untouched.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green (repo gate).

## Out of scope

- vendo-web (marketing site, console) changes.
- New feature documentation not already on a page.
- Restructuring `docs/` (the internal integration docs) or `docs/archive/contracts/`.
- Mintlify plan changes; everything here works on the current plan.
