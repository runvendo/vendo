# Vercel AI SDK + Mastra Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the three existing-agents docs pages, produce a branded launch
graphic, and draft the X post announcing the Vercel AI SDK and Mastra
connectors.

**Architecture:** Docs-only PR on `yousefh409/vercel-mastra` (no code or
behavior changes). Graphic is a standalone HTML file rendered to PNG with
Playwright, kept outside the repo. Post is a text draft handed to Yousef.

**Spec:** `docs/superpowers/specs/2026-07-23-vercel-mastra-launch-design.md`

---

### Task 1: Source official Vercel and Mastra logo SVGs

**Files:**
- Create: `docs-site/images/logos/vercel.svg`, `docs-site/images/logos/mastra.svg` (path adjusted to wherever docs-site already keeps images)

- [ ] Find where docs-site stores images/icons today and follow that convention
- [ ] Fetch the official Vercel triangle mark (vercel.com brand assets) and the official Mastra mark (mastra.ai / their GitHub) as SVG; verify each renders and is the genuine mark
- [ ] Confirm the marks read at card-icon size on both light and dark Mintlify themes; adjust fill (currentColor or per-theme variants) if needed

### Task 2: Polish `docs-site/existing-agents/ai-sdk.mdx`

**Files:**
- Modify: `docs-site/existing-agents/ai-sdk.mdx`

- [ ] First mention in the intro reads "Vercel's AI SDK"; title stays "Quickstart: AI SDK"
- [ ] Compress the "Try it" Warning to roughly 5 lines keeping only: your loop keeps its own key, builds ride an explicit provider key unless `VENDO_DEV_CREDENTIAL=vendo-cloud`, `npx vendo login` mints a free dev key, real-chat-turn done-criterion; link the rest to the dev-mode ladder page
- [ ] Collapse the two long principal-mismatch passages into one tight Note (keep the "infinite pending skeleton" symptom); the second site becomes a one-line pointer
- [ ] Tighten the step-1 "lift the composition" prose; no factual changes
- [ ] Add the Vercel page icon in frontmatter
- [ ] Commit

### Task 3: Polish `docs-site/existing-agents/mastra.mdx`

**Files:**
- Modify: `docs-site/existing-agents/mastra.mdx`

- [ ] Same four polish moves as Task 2 (Warning compress, principal-caveat dedupe, step-1 tighten, Mastra page icon)
- [ ] Keep the GPT-5/history-replay workaround Note but tighten to one sentence
- [ ] Commit

### Task 4: Overview cards get logos, `docs-site/existing-agents/index.mdx`

**Files:**
- Modify: `docs-site/existing-agents/index.mdx`

- [ ] Add Vercel and Mastra SVG icons to the two quickstart cards
- [ ] Read the page top-to-bottom once for consistency with the new quickstart wording; tighten only if something now disagrees
- [ ] Commit

### Task 5: Verify in a real browser

- [ ] Run the docs-site dev server (Mintlify) locally
- [ ] Screenshot all three pages, light and dark, plus the overview cards with logos
- [ ] Fix anything that renders poorly; re-screenshot
- [ ] Run `pnpm build && pnpm test && pnpm typecheck && pnpm lint`; all green
- [ ] Commit any fixes

### Task 6: Open the docs PR

- [ ] Push branch, open PR with before/after screenshots embedded (repo rule for UI-affecting changes)
- [ ] Title/body describe the polish pass and link the spec

### Task 7: Launch graphic

**Files:**
- Create: `/tmp/vendo-launch-graphic/card.html` and rendered `card.png` (not committed to the repo)

- [ ] Read the dataviz/canvas-design guidance before writing the card
- [ ] Build a 1200x675 code card: Vendo brand system (porcelain/ink/ultramarine), the real one-spread snippet trimmed to ~8 lines, Vendo x Vercel x Mastra logo row, one tagline
- [ ] Render to PNG via Playwright at 2x, review visually, iterate until pristine
- [ ] Deliver the PNG path to Yousef

### Task 8: X post draft

- [ ] Use write-as-me (social context) to draft one post: hook, "keep your agent, three steps" pitch, docs link, graphic attached
- [ ] Deliver draft text to Yousef; he posts after the docs PR merges and docs.vendo.run redeploys

### Self-review

- Spec coverage: Tasks 2-6 = deliverable 1; Task 7 = deliverable 2; Task 8 = deliverable 3; sequencing note in Task 8. No gaps.
- No placeholders; no code in plan per Yousef's planning rules.
