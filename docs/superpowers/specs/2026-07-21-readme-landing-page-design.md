# README landing-page redesign

2026-07-21. Approved via mockup review. The approved composition is
committed next to this spec as
`2026-07-21-readme-landing-page-mockup.html` (open it in a browser; it
references the repo GIFs relatively). It is the visual reference for
implementation; where prose and mockup disagree, the mockup wins.

## Goal

Make the repo README read like a landing page in the new violet brand while
keeping every piece of technical content. Scope is the README plus the
`assets/` directory. No GIF recapture, no docs-site changes.

## Brand source of truth

vendo-web `Brand.md` and `public/brand/`: violet `#6C3BFF`, lilac `#A78BFA`,
ink `#0E0B1A`, Onest (display) + Geist Mono (kickers, badges, data chrome).
The canonical mark is vendo-web `public/brand/vendo-mark-violet.svg` (blob +
four pixel squares). The banner design follows the designer's X banner:
violet gradient, pixel-square motif, white lockup, headline "Your product,
shaped to every customer.", subline, "Backed by Y Combinator" badge.

## New assets (all in `assets/`)

- `banner.svg`: animated rebuild of the designer's banner at 1280x400.
  Violet gradient `#7B57F7 -> #5527E0`, slowly drifting radial glow,
  pixel squares breathing on staggered SMIL cycles, white mark + wordmark,
  headline, subline, YC badge. No typing cursor. Self-backgrounded, so one
  asset serves light and dark GitHub. Replaces `banner-light.svg` and
  `banner-dark.svg` (deleted).
- `footer.svg`: animated aurora band at 1280x240 on ink. Blurred violet and
  lilac ellipses swaying on staggered phases, headline "Shaped to every
  customer.", white star pill reading "Star runvendo/vendo", small mono line
  "Apache-2.0 · docs.vendo.run · vendo.run · Backed by Y Combinator".
  Embedded as a linked image pointing at the repo.
- Three badge SVGs (`badge-npm.svg`, `badge-license.svg`, `badge-docs.svg`):
  self-hosted violet-system badges (Geist Mono, ink or violet fill, pixel
  notch). Stable facts only: package name, Apache-2.0, docs.vendo.run. No
  version numbers or CI state, so they never go stale. Each is a linked
  image (npm package page, LICENSE, docs.vendo.run).
- Four kicker SVGs (`kicker-01-install.svg` .. `kicker-04-packages.svg`):
  small mono strips ("01 · INSTALL" etc.) with a pixel square stepping
  through the violet ramp. Placed directly above each `##` heading.
- `agent-logos.svg` + `agent-logos-dark.svg`: the five coding-agent marks
  (Claude Code in its orange, Cursor, GitHub Copilot, OpenAI Codex,
  Windsurf in neutral gray tuned per mode), used by the install section via
  `<picture>`.
- Replace the old indigo `vendo-mark.svg`, `vendo-mark-mono.svg`, and
  `vendo-icon.svg` with the canonical violet mark family copied from
  vendo-web `public/brand/`.

Text inside shipped SVGs is converted to paths so rendering does not depend
on installed fonts. For each text-bearing asset, an editable source copy
with live text is kept under `assets/src/` with a short note on how to
regenerate the paths version.

## Page structure

1. Banner (animated SVG).
2. Centered brand one-liner ("An open-source customization layer. Your
   users build their own features and micro-apps, right on top of your
   product.") plus the support line ("Vendo puts an agent inside your
   product: customers build views, act through your APIs, and automate
   work, inside your brand and guardrails.").
3. Badge row (the three custom badges).
4. Link row with docs.vendo.run first and bold: docs.vendo.run ·
   Quickstart · vendo.run.
5. `01 · INSTALL` / "Install in 60 seconds": npm install + `npx vendo init`
   code block; then the agent-prompt presentation: bold lead ("Or install
   with your coding agent"), the agent-logos strip, the canonical prompt
   verbatim from `docs-site/install.mdx` in a text code block (GitHub's
   native copy button serves as the copy affordance), then one paragraph:
   init proposes permission-gated diffs, `vendo doctor --json` gates done,
   every error code links to its fix, full playbook at
   docs.vendo.run/install.
6. `02 · SEE IT` / "See it in action": the existing 2x2 GIF table and
   captions, byte-for-byte unchanged.
7. `03 · HOW IT WORKS`: three steps (Extract, Generate, Guard) followed by
   the PGlite/Postgres, automations, and headless-hooks prose. This section
   absorbs the old "What Vendo does" and "Install flow" sections. One
   compact sentence keeps the machine-readable agent surfaces
   (docs.vendo.run/install.md, llms.txt, `vendo init --agent`, the
   `vendo-setup` skill).
8. `04 · PACKAGES`: the full 11-row table plus the composition note
   (`@vendoai/vendo` default, `vendoai` alias, compose from blocks). The
   cloud-gating sentence from the old License section lands here.
9. Aurora footer (linked animated SVG). The standalone License heading is
   removed; the license fact lives in the footer line, the badge, and the
   LICENSE file.

No technical fact from the current README is dropped; sections are
re-homed, not deleted.

## Constraints

- GitHub markdown only: layout table for the grid, `<picture>` for
  mode-sensitive images, linked `img` elements, SMIL inside repo-hosted
  SVGs. Nothing that GitHub's sanitizer strips.
- The canonical agent prompt is owned by `docs-site/install.mdx`; the
  README copies it verbatim at implementation time and must be re-checked
  against it (the vendo-web login-command track may have landed changes).
- Repo rule: UI-affecting changes are verified in a real browser with
  screenshots in the PR.

## Verification

- Render the branch README on github.com in light and dark modes; confirm
  layout, badges, kickers, and that SMIL animation plays through GitHub's
  camo proxy. Screenshots go in the PR.
- If camo blocks SMIL on any asset, ship the same SVGs without the animate
  nodes: identical layout, static. This is the accepted fallback and needs
  no redesign.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before the
  PR (README/assets should not affect them, but the rule stands).

## Out of scope

GIF recapture, comparison table, typing-terminal SVG, architecture
diagram, video embed, self-updating stats, easter eggs, docs-site or
vendo-web changes.
