# README Landing-Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebrand the repo README as a violet-brand landing page: animated banner and footer, custom badges, section kickers, agent-prompt card, restructured sections.

**Architecture:** All visuals ship as SVG files in `assets/` (SMIL animation, text converted to paths); the README is plain GitHub markdown referencing them. The committed mockup `docs/superpowers/specs/2026-07-21-readme-landing-page-mockup.html` is the binding visual reference; the spec `docs/superpowers/specs/2026-07-21-readme-landing-page-design.md` is the content contract.

**Tech Stack:** SVG + SMIL, GitHub-flavored markdown, a one-off Node text-to-path conversion script (opentype.js with downloaded Onest and Geist Mono fonts), Playwright for render checks.

**Conventions:** Branch `yousefh409/readme-landing-page` (never main). Screenshot evidence is committed under `docs/verification/readme-landing-page/` with `git add -f` (the root `.gitignore` excludes `*.png`) and embedded in the PR body via raw.githubusercontent URLs.

---

### Task 1: Violet mark family

**Files:**
- Replace: `assets/vendo-mark.svg`, `assets/vendo-mark-mono.svg`, `assets/vendo-icon.svg`
- Source of truth: vendo-web `public/brand/` (vendo-mark-violet.svg and siblings)

- [ ] Copy the canonical violet mark family from the vendo-web workspace into `assets/`, keeping this repo's existing file names so external links stay valid
- [ ] Confirm each file renders (open in browser), and that no repo file other than README references them (grep already confirms only README uses banner files)
- [ ] Commit

### Task 2: Editable SVG sources

**Files:**
- Create: `assets/src/banner.svg`, `assets/src/footer.svg`, `assets/src/badge-npm.svg`, `assets/src/badge-license.svg`, `assets/src/badge-docs.svg`, `assets/src/kicker-01-install.svg` through `assets/src/kicker-04-packages.svg`, `assets/src/agent-logos.svg`, `assets/src/agent-logos-dark.svg`
- Create: `assets/src/README.md` (one paragraph: what lives here, how to regenerate shipped assets)

- [ ] Extract each SVG from the committed mockup into a standalone file with live `font-family` text (banner: drop the mockup's HTML-inherited font stack in favor of explicit Onest/Geist Mono family names; keep all SMIL animation nodes; no typing cursor in the banner)
- [ ] Banner: 1280x400, per spec (gradient, drifting glow, breathing pixels, lockup, headline, subline, YC badge)
- [ ] Footer: 1280x240 aurora band per spec (headline, star pill, mono footer line)
- [ ] Badges: three stable-fact badges per spec (npm name, Apache-2.0, docs.vendo.run) with the pixel-notch style from the mockup
- [ ] Kickers: four mono strips, pixel square stepping through the violet ramp
- [ ] Agent logos: one row of the five coding-agent marks from `docs-site/snippets/agent-prompt.jsx` (Claude Code keeps its orange; the rest neutral gray per mode); dark variant lightens the neutrals
- [ ] Open each source file in a browser with Onest/Geist Mono available and compare against the mockup side by side
- [ ] Commit

### Task 3: Text-to-path conversion and shipped assets

**Files:**
- Create: `scripts/readme-assets-build.mjs` (one-off converter; documented in `assets/src/README.md`)
- Create: `assets/banner.svg`, `assets/footer.svg`, `assets/badge-npm.svg`, `assets/badge-license.svg`, `assets/badge-docs.svg`, `assets/kicker-01-install.svg` … `assets/kicker-04-packages.svg`, `assets/agent-logos.svg`, `assets/agent-logos-dark.svg`

- [ ] Write the converter: reads each `assets/src/*.svg`, replaces every text node with path outlines using opentype.js and locally downloaded Onest + Geist Mono files (both OFL-licensed; fonts are not committed), preserves all non-text nodes including SMIL animations, writes the shipped file to `assets/`
- [ ] Run it and confirm each shipped SVG contains no `<text>` or `font-family` and matches its source visually in a browser with webfonts disabled
- [ ] Confirm shipped banner and footer still animate (SMIL survives conversion)
- [ ] Check file sizes stay reasonable (each under ~150 KB)
- [ ] Commit shipped assets + script

### Task 4: README rewrite

**Files:**
- Modify: `README.md` (full rewrite per spec section "Page structure")
- Delete: `assets/banner-light.svg`, `assets/banner-dark.svg`

- [ ] Re-read the canonical prompt in `docs-site/install.mdx` first and copy it verbatim (the login-command track may have changed it since the spec was written)
- [ ] Rewrite README.md to the nine-part structure in the spec: banner, one-liner + support line, badge row (linked images), docs-first link row, 01 Install (npm block + agent-prompt presentation with logos strip via picture + prompt code block + doctor paragraph), 02 See it in action (existing GIF table byte-for-byte unchanged), 03 How it works (Extract/Generate/Guard + absorbed prose + one agent-surfaces sentence), 04 Packages (full table + composition note + cloud-gating sentence), aurora footer as a linked image
- [ ] Verify against the spec's "no technical fact dropped" rule: diff old README against new and account for every removed line's content re-home
- [ ] Delete the two old banner files
- [ ] Commit

### Task 5: Local render verification

- [ ] Render the new README with a GitHub-markdown previewer and screenshot at desktop width; compare against the mockup
- [ ] Screenshot the banner and footer SVGs standalone in a browser to confirm animation plays and text-as-paths renders identically to the mockup
- [ ] Simulate dark mode (previewer or GitHub dark) and confirm badges, kickers, and agent-logos dark variant read correctly
- [ ] Fix any drift, re-render, commit fixes

### Task 6: Repo gates

- [ ] Run `pnpm build && pnpm test && pnpm typecheck && pnpm lint`; all green (this change should not affect them; if lint's dependency guard flags the new script, adjust placement rather than the guard)
- [ ] Commit anything the gates required

### Task 7: GitHub-real verification and PR

- [ ] Push the branch; open the branch README on github.com in light and dark modes
- [ ] Confirm the SMIL animations actually play through GitHub's camo proxy; if camo blocks them, regenerate the affected assets without animate nodes (accepted fallback per spec) and re-verify
- [ ] Capture light + dark screenshots; commit under `docs/verification/readme-landing-page/` with `git add -f`
- [ ] Open the PR using the repo PR template, embed the screenshots via raw.githubusercontent URLs, note the fallback decision if taken
- [ ] Confirm CI is green on the PR
