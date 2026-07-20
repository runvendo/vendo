# Docs Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle docs.vendo.run to the new brand and restructure it into a journey IA with a two-path sidebar fork (bring your own agent recommended, Vendo's agent beta), per the approved spec.

**Architecture:** Two sequential PRs against the flowlet repo, `docs-site/` only. PR 1 changes how the site looks and is organized without rewriting prose (theme, tokens, nav, redirects, merges, new Welcome page). PR 2 rewrites content page by page to the one-job-per-page standards. File paths stay put wherever a page survives; only the five killed paths get redirects.

**Tech Stack:** Mintlify (`docs.json`, theme `almond`, MDX), Mintlify CLI (`npx mint dev`, `npx mint broken-links`), Playwright MCP for screenshots.

**Spec:** `docs/superpowers/specs/2026-07-20-docs-revamp-design.md`. The spec's IA section is the authoritative page map; this plan does not restate every page's disposition.

**Rules that bind every task:**
- `agents/verify.mdx`: path and every `{#E-XXX-NNN}` anchor must survive byte-identical (live `fix_ref` targets from `vendo doctor`).
- `reference/handler-options.mdx`: options table is test-pinned; structure stays verbatim.
- `install.mdx` keeps its path (`install.md` is a published agent surface).
- Changelog is never rewritten.
- Commit after each task. Verify in the running `mint dev` preview before every commit that touches a page.

---

## Phase A — PR 1: visual layer + IA skeleton (branch: `yousefh409/docs-revamp`, current)

### Task 1: Brand assets

**Files:** Replace `docs-site/logo/light.svg`, `docs-site/logo/dark.svg`, `docs-site/favicon.svg`.

- [ ] List `public/brand/` in the vendo-web repo (branch `console/rebuild`, falling back to main) and identify the morph-blob mark and lockup SVGs.
- [ ] Copy the violet lockup for light mode, the light-on-dark lockup for dark mode, and the mark alone as favicon. If no ready lockup SVG exists, compose one from the mark path plus the lowercase wordmark per the vendo-mark.tsx spec (mark at cap-height x1.1, gap 0.32em).
- [ ] Start `npx mint dev` in `docs-site/` and confirm both logos and the favicon render.
- [ ] Commit.

### Task 2: docs.json restyle

**Files:** Modify `docs-site/docs.json`.

- [ ] Change theme from `maple` to `almond`.
- [ ] Set colors: primary `#6c3bff`, light `#a78bfa`, dark `#8b6bff`. Background: white light / `#0a0a0c` dark. Light remains the default appearance.
- [ ] Set fonts: Onest for heading and body (Google Fonts by name). Keep the existing `contextual` options block.
- [ ] Confirm in the preview: theme switched, violet accents, Onest rendering, both appearances.
- [ ] Commit.

### Task 3: styles.css to whisper-brand

**Files:** Modify `docs-site/styles.css`.

- [ ] Keep the heading letter-spacing rule. Update the CSS variables from the old porcelain/ultramarine names to the new brand tokens.
- [ ] Add: Geist Mono for code spans and blocks (only if the theme's default mono is not already acceptable), the PR #84 card shadow recipe on cards, violet link hover accents. Nothing that fights the theme's layout.
- [ ] Confirm in the preview on a code-heavy page (reference/cli) and a card page, both appearances.
- [ ] Commit.

### Task 4: page merges, content intact

**Files:** Modify `docs-site/quickstart.mdx`, `docs-site/capabilities/connected-accounts.mdx`, `docs-site/ui/components.mdx`, `docs-site/connect/instructions.mdx`. Create `docs-site/existing-agents/embeds.mdx`. Delete `docs-site/quickstart-node.mdx`, `docs-site/capabilities/integrations.mdx`, `docs-site/capabilities/voice.mdx`, `docs-site/concepts/prompts.mdx`, `docs-site/connect/tool-labels.mdx`.

This task moves prose without rewriting it; polish happens in PR 2.

- [ ] Fold quickstart-node into quickstart as framework tabs (Next.js / Express and other runtimes), deduplicating the policy, trusted-origin, and persistence blocks that the two pages repeat near-verbatim.
- [ ] Move the integrations stub's connector-factory content into connected-accounts as its opening section.
- [ ] Move voice and tool-labels content into ui/components as sections.
- [ ] Move the prompts stub's assembly-order content into instructions.
- [ ] Create existing-agents/embeds.mdx from the embeds section of existing-agents/index.mdx (leave a link behind; the hooks and ui/components copies get reduced to links in PR 2).
- [ ] Walk every merged page in the preview; confirm nothing rendered broken.
- [ ] Commit.

### Task 5: nav restructure + redirects

**Files:** Modify `docs-site/docs.json`.

- [ ] Rebuild `navigation.groups` to the spec's 10 groups, in order: Start here / Bring your own agent / Use Vendo's agent / Connect your app / Make it yours / Give it reach / Ship it / For coding agents / Reference / Changelog.
- [ ] Tag the BYO group `Recommended` and the Vendo-agent group `Beta`.
- [ ] Add redirects for the five killed paths, each pointing at its absorbing page.
- [ ] Confirm in the preview: sidebar matches the approved mockup, tags render, every nav entry opens, each old URL redirects.
- [ ] Commit.

### Task 6: new Welcome page

**Files:** Rewrite `docs-site/index.mdx`.

- [ ] Rebuild as the chooser per the approved mockup: short hero, BYO card (Recommended) linking to existing-agents, Vendo-agent card (Beta) linking to quickstart, coding-agents card linking to agents, four-step journey strip mirroring the shared groups. Use stock Mintlify components (Card, CardGroup, Columns); no bespoke HTML.
- [ ] Move the current index's "Default behavior" reference content into reference/handler-options territory only if it is not already there; otherwise drop it (the scout confirmed it duplicates handler-options and install).
- [ ] Confirm in the preview, both appearances.
- [ ] Commit.

### Task 7: PR 1 verification and ship

- [ ] Guard check: extract the sorted anchor list from agents/verify.mdx and diff against main; must be identical. Diff reference/handler-options.mdx against main; must be untouched in this PR.
- [ ] Run `npx mint broken-links`; fix anything it reports.
- [ ] Screenshot via Playwright: Welcome plus one page per group, light and dark.
- [ ] Run `pnpm build && pnpm test && pnpm typecheck && pnpm lint` at repo root; all green.
- [ ] Open PR 1 with before/after screenshots. Title: docs-site: new brand + journey IA skeleton.

---

## Phase B — PR 2: content rewrite (branch off main after PR 1 merges: `yousefh409/docs-content`)

Standards for every task in this phase (from the spec): one job per page; 2-3 sentence intro then code within the first screen; concept, how-to, and reference never share a scroll; guide pages 150 lines or less (Reference exempt); canonical-home rule; beta callout on all Vendo-agent-specific content; second person, direct, no marketing adjectives.

### Task 8: canonical homes

**Files:** Modify the six canonical pages and every page that currently restates them (the spec lists both sides).

- [ ] Give each repeated fact its single home: Cloud-key rule in vendo-cloud, model ladder in dev-mode, init flags in reference/cli, auth preset tables in act-as-presets, error table in troubleshooting, policy semantics in handler-options.
- [ ] Reduce every other occurrence to one sentence plus a link. Preserve the handler-options pinned table exactly.
- [ ] Preview-check each touched page; commit.

### Task 9: Start here group

**Files:** Modify `index.mdx`, `install.mdx`, `concepts/architecture.mdx`, `concepts/tools-and-safety.mdx`.

- [ ] Finalize Welcome copy. Retitle architecture to "How Vendo works" (title only, path stays) and absorb the composition theory currently burying quickstart's code. Trim install to the staged playbook plus the agent-surfaces table. Reshape tools-and-safety so concept comes first and the accuracy-critical decision-order material sits in a clearly marked reference section.
- [ ] Preview-check; commit.

### Task 10: Bring your own agent group

**Files:** Modify `existing-agents/index.mdx`, `existing-agents/ai-sdk.mdx`, `existing-agents/mastra.mdx`, `existing-agents/embeds.mdx`.

- [ ] Index becomes "Overview and tool pack": the recommendation posture, tool-pack table, envelope contract. Retitle the walkthroughs as quickstarts and tighten to the four-touch structure they already have. Flesh out embeds.mdx as the canonical embeds page; reduce the copies in reference/hooks and ui/components to links.
- [ ] Preview-check; commit.

### Task 11: Use Vendo's agent group

**Files:** Modify `quickstart.mdx`, `ui/components.mdx`.

- [ ] Add the standard beta callout to both. Quickstart keeps only happy-path steps (theory moved in Task 9, overlay hook reference moves to reference/hooks). Restructure ui/components into the surface catalog with the merged voice and tool-labels sections placed logically.
- [ ] Preview-check; commit.

### Task 12: Connect your app group

**Files:** Modify `connect/vendo-init.mdx`, `connect/api-tools.mdx`, `connect/act-as-presets.mdx`, `connect/dev-mode.mdx`.

- [ ] vendo-init keeps the narrative (what init writes, detection precedence) and links to reference/cli for flags. api-tools keeps its extractor reference but gains a how-to opening. act-as-presets absorbs its canonical role from Task 8. dev-mode becomes the single model-ladder home.
- [ ] Preview-check; commit.

### Task 13: Make it yours group

**Files:** Modify `connect/theming.mdx`, `connect/host-components.mdx`, `connect/instructions.mdx`.

- [ ] Theming: how-to first, token/variable tables as reference sections. Host-components: split registration reference from remix/drift concept with clear headings. Instructions: unify the merged prompts content into one channel-routing page titled "Prompts and instructions".
- [ ] Preview-check; commit.

### Task 14: Give it reach group

**Files:** Modify `capabilities/connected-accounts.mdx`, `capabilities/mcp.mdx`, `capabilities/mcp-registry.mdx`, `capabilities/compound-tools.mdx`, `concepts/generated-ui.mdx`, `concepts/in-client-venue.mdx`.

- [ ] Connected-accounts: integrate the merged connector intro, then the user-flow how-to, endpoint table last. MCP door: biggest restructure — enable-and-consent how-to up front; JWT claims, well-known paths, and federation wire detail into a marked reference tail. Registry stays a sequel how-to. Generated-ui and in-client-venue keep their concept lead but move wire shapes (approval records, ship-diff JSON) into reference sections.
- [ ] Preview-check; commit.

### Task 15: Ship it group

**Files:** Modify all seven `deploy/` pages.

- [ ] deploying becomes the production checklist hub linking into the other six. persistence, vendo-cloud, principals-and-orgs, scheduler-and-webhooks, telemetry get the standards pass; troubleshooting becomes the canonical error-table home (Task 8) plus doctor pointers.
- [ ] Preview-check; commit.

### Task 16: For coding agents group

**Files:** Modify `agents/index.mdx`, `agents/host-auth.mdx`, `agents/tools.mdx`. Do not touch `agents/verify.mdx`.

- [ ] Keep the rules-of-engagement and detection-signal content (agent-behavior-critical); replace the material restated from install, act-as-presets, and api-tools with links. Verify stays byte-identical.
- [ ] Preview-check; commit.

### Task 17: Reference group

**Files:** Modify all seven `reference/` pages.

- [ ] Dedupe against the canonical homes (cli's init/doctor/cloud sections keep flags but link out for narrative; hooks drops the embeds copy for a link; server-api and handler-options cross-link rather than restate). Pinned table untouched.
- [ ] Preview-check; commit.

### Task 18: accuracy reconciliation

- [ ] Resolve the execution-venue enum against the packages source (`e2b|modal|custom` in http-routes vs `e2b|cloud|custom` in verify; changelog mentions a Modal adapter). Fix whichever pages are wrong; verify anchors still untouched if verify is the wrong one — if so, fix prose only, never anchor IDs.
- [ ] Spot-compile the quickstart and BYO code samples against the current `@vendoai/*` packages.
- [ ] Commit.

### Task 19: PR 2 verification and ship

- [ ] Guard check: verify anchors identical to main; handler-options table structurally identical.
- [ ] Length audit: every journey/guide page at or under 150 lines, or has a recorded reason.
- [ ] `npx mint broken-links` clean.
- [ ] Playwright screenshots: one page per group, light and dark.
- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- [ ] Open PR 2 with screenshots. Title: docs-site: content rewrite to journey standards.
