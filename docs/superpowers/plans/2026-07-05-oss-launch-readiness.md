# Vendo OSS Launch Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `runvendo/vendo` ready to flip public and publish `@vendoai/*` 0.1.0 to npm — branding, README, Apache-2.0, community files, tree cleanup, Node-loadable dists, CI, and a verified fresh-machine `vendo init`.

**Architecture:** One mega-PR on `yousefh409/open-source-ready`. Order: scan → delete → de-secret-manager → rename purge → license → community → branding → npm-readiness → CI → E2E → PR. The spec (`docs/superpowers/specs/2026-07-05-oss-launch-readiness-design.md`) records all locked decisions; consult it on any judgment call.

**Tech Stack:** pnpm + turbo monorepo, tsc/vite/tsup builds, gitleaks, opentype.js (banner), GitHub Actions, Playwright (screenshots).

**Standing rules for every task:** the product is **Vendo**, never Flowlet, in all new prose/code/commits. Commit after each task with the trailer `Claude-Session: https://claude.ai/code/session_01C3iN3nkdQq7HC3AuFeTcED`. Never merge — Yousef merges.

---

### Task 1: Secret scan (tree + full history)

History ships as-is (locked decision), so the point is finding **live credentials to rotate before the flip**, not rewriting.

**Files:** none modified; report only.

- [ ] **Step 1: Run gitleaks over the full history**

```bash
brew list gitleaks >/dev/null 2>&1 || brew install gitleaks
cd /Users/yousefh/orca/workspaces/flowlet/open-source-ready
gitleaks git . --redact -v --report-path /private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-open-source-ready/19b20ed6-dd35-4c02-b699-3074d5e628d7/scratchpad/gitleaks-history.json 2>&1 | tail -20
```

Expected: exit 0 (no leaks) or a findings list.

- [ ] **Step 2: Triage findings**

For each finding, classify: (a) test fixture / fake key → note and ignore; (b) real key → check if it's active (do NOT print full values). Anthropic/OpenAI/Composio/PostHog keys are the likely candidates. Write a one-paragraph triage summary.

- [ ] **Step 3: Report to Yousef**

If any live credential exists in history, STOP and tell Yousef which service needs rotation before the repo flips public. This blocks Task 15's launch checklist, not the rest of the PR.

### Task 2: Tree cleanup — deletions

**Files:**
- Delete: `apps/gmail/`, `audit/`, `verification/`, `previews/`, `private/`, `motion*.gif`, `motion*.mp4`, `docs/superpowers/` (EXCEPT `specs/2026-07-05-oss-launch-readiness-design.md` and `plans/2026-07-05-oss-launch-readiness.md` — those go in Task 15), `docs/PRD.md`, `docs/audit/`, `docs/verification/`, `docs-site/`
- Modify: root `package.json` (drop `demo:gmail` script)

- [ ] **Step 1: Delete the directories and files**

```bash
git rm -rq apps/gmail audit verification previews private docs-site docs/PRD.md docs/audit docs/verification
git rm -q motion*.gif motion*.mp4
# superpowers: delete everything except the two live launch docs
find docs/superpowers -type f ! -name '2026-07-05-oss-launch-readiness-design.md' ! -name '2026-07-05-oss-launch-readiness.md' -print0 | xargs -0 git rm -q
```

- [ ] **Step 2: Remove the gmail script from root package.json**

Delete the `"demo:gmail"` line from `package.json` scripts (leave `demo`/`demo:accounting` for Task 3).

- [ ] **Step 3: Sweep for dangling references**

```bash
grep -rn "apps/gmail\|gmail-demo\|docs-site\|docs/PRD" --include='*.json' --include='*.md' --include='*.ts' --include='*.yaml' . | grep -v node_modules | grep -v docs/superpowers
```

Fix every hit (CLAUDE.md hits get fixed in Task 6's rewrite; note them). Check `pnpm-workspace.yaml` still globs correctly.

- [ ] **Step 4: Reinstall + full gates**

```bash
pnpm install && pnpm build && pnpm test
```

Expected: lockfile shrinks (gmail deps gone); build and tests green.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: remove internal artifacts and unlicensed gmail demo from tree"
```

### Task 3: De-Infisical the scripts + .env.example files

**Files:**
- Modify: `package.json` (root), `apps/demo-bank/README.md`, `apps/demo-accounting/README.md`
- Create: `apps/demo-bank/.env.example`, `apps/demo-accounting/.env.example`

- [ ] **Step 1: Rewrite root scripts without Infisical**

In root `package.json`, replace the `demo`, `demo:accounting`, `composio:connect` scripts with:

```json
"demo": "pnpm --filter demo-bank dev",
"demo:accounting": "pnpm --filter demo-accounting dev",
"composio:connect": "node scripts/composio-connect.mjs"
```

- [ ] **Step 2: Discover each demo's actual env needs**

```bash
grep -rhoE "process\.env\.[A-Z_]+" apps/demo-bank --include='*.ts' --include='*.tsx' | sort -u
grep -rhoE "process\.env\.[A-Z_]+" apps/demo-accounting --include='*.ts' --include='*.tsx' | sort -u
grep -rhoE "process\.env\.[A-Z_]+" packages/vendo-server/src packages/vendo-runtime/src | sort -u
```

Known set: `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`), `COMPOSIO_API_KEY`, `OPENAI_REALTIME_MODEL/VOICE`, `SLACK_CHANNEL_ID`, `VENDO_DEMO_MODEL`, `VENDO_JUDGE_MODEL`. Confirm which app needs which; check how each app loads env (Next.js loads `.env.local` natively).

- [ ] **Step 3: Write `.env.example` for each app**

`apps/demo-bank/.env.example` (adjust to Step 2 findings, comment every var):

```bash
# Required — any one provider key
ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GOOGLE_GENERATIVE_AI_API_KEY=

# Optional — external tool integrations (Gmail/Slack/Calendar via Composio)
# COMPOSIO_API_KEY=

# Optional — model overrides
# VENDO_DEMO_MODEL=
```

Same pattern for demo-accounting (plus its voice vars if used: `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_VOICE`).

- [ ] **Step 4: Document in each app README**

Add a "Setup" section: `cp .env.example .env.local`, fill in a key, `pnpm dev`. Keep it three lines.

- [ ] **Step 5: Verify demo boots on plain env**

```bash
cd apps/demo-bank && cp .env.example .env.local
# put a real ANTHROPIC_API_KEY into .env.local from your shell env if available
cd ../.. && timeout 30 pnpm demo & sleep 20; curl -sf http://localhost:3000 >/dev/null && echo BOOT_OK
```

Expected: `BOOT_OK`. Kill the dev server after. Remove the `.env.local` you created (never commit it).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: drop Infisical coupling; demos run on plain .env files"
```

### Task 4: Purge flowlet references from shipped code

**Files:**
- Modify: `packages/vendo-runtime/src/mcp.ts`, `packages/vendo-runtime/src/automations/schema.ts`, `packages/vendo-runtime/src/automations/schema.test.ts`, plus whatever the sweep finds.

- [ ] **Step 1: Inspect the three known hits**

```bash
grep -n -i "flowlet" packages/vendo-runtime/src/mcp.ts packages/vendo-runtime/src/automations/schema.ts packages/vendo-runtime/src/automations/schema.test.ts
```

CAUTION: if a hit is a **persisted-format key** (automation DSL field names, stored manifest keys, DB values), renaming breaks stored data. For those: leave the identifier, add a one-line comment stating it's a frozen legacy key. Comments/docstrings/log strings: rename to Vendo freely.

- [ ] **Step 2: Full-tree sweep**

```bash
grep -rn -i "flowlet" --include='*.ts' --include='*.tsx' --include='*.js' --include='*.json' --include='*.md' --include='*.css' --include='*.yaml' . | grep -v node_modules | grep -v docs/superpowers | grep -v pnpm-lock
```

Fix every hit by the same rule (rename unless persisted-format).

- [ ] **Step 3: Gates**

```bash
pnpm build && pnpm test && pnpm typecheck
```

Expected: green. (The rename-status memory notes key-sort-order test traps — if a test fails on key ordering, that's why.)

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: purge remaining flowlet references from shipped code"
```

### Task 5: LICENSE, NOTICE, license fields, attribution audit

**Files:**
- Create: `LICENSE`, `NOTICE`
- Modify: all 13 `package.json`s (root, 12 packages) + `apps/demo-bank/package.json`, `apps/demo-accounting/package.json`, `examples/*/package.json`

- [ ] **Step 1: Add LICENSE and NOTICE**

```bash
curl -sf https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE
head -3 LICENSE   # verify it downloaded the real text
```

Create `NOTICE`:

```
Vendo
Copyright 2026 Vendo

This product includes software developed at Vendo (https://vendo.run).
```

- [ ] **Step 2: Add license field everywhere**

```bash
node -e '
const fs=require("fs");
for (const p of ["package.json",...require("fs").readdirSync("packages").map(d=>`packages/${d}/package.json`),...require("fs").readdirSync("apps").map(d=>`apps/${d}/package.json`),...require("fs").readdirSync("examples").map(d=>`examples/${d}/package.json`)]) {
  if(!fs.existsSync(p)) continue;
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.license="Apache-2.0";
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
}'
git diff --stat
```

Expected: ~18 files changed, `"license": "Apache-2.0"` in each. Verify JSON key ordering didn't scramble anything important (`git diff` should show only the added line per file — if `JSON.stringify` reordered keys, revert and add the field with Edit per file instead).

- [ ] **Step 3: Attribution audit**

```bash
grep -rn -iE "copyright|licen[cs]e|MIT|Apache|BSD" packages/vendo-components/src --include='*.ts' --include='*.tsx' -l | head
cat packages/vendo-components/package.json | node -e "process.stdin.on('data',d=>console.log(Object.keys(JSON.parse(d).dependencies||{})))"
```

vendo-components wraps OpenUI (Crayon rebrand) — find the upstream license (check `node_modules/<pkg>/LICENSE` for its deps, and any vendored source headers). If any code was **copied in** (not npm-dep'd), append its copyright + license notice to `NOTICE`. npm dependencies need nothing. Do the same check for `packages/vendo-sandbox-shims/` and `vendor/` (fluidkit is our own IP — nothing needed).

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: Apache-2.0 license, NOTICE, license fields across the workspace"
```

### Task 6: Community files + public CLAUDE.md

**Files:**
- Create: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.github/CODEOWNERS`, `.github/ISSUE_TEMPLATE/bug_report.md`, `.github/ISSUE_TEMPLATE/feature_request.md`, `.github/PULL_REQUEST_TEMPLATE.md`
- Rewrite: `CLAUDE.md`

- [ ] **Step 1: CONTRIBUTING.md**

```markdown
# Contributing to Vendo

Thanks for helping make Vendo better.

## Development setup

```bash
pnpm install
pnpm build
pnpm test
```

Node 20+, pnpm 9. The repo is a turbo monorepo: `packages/` are the published
`@vendoai/*` libraries, `apps/` are demo hosts, `examples/` are minimal usage
examples.

Run a demo host: `pnpm demo` (see `apps/demo-bank/README.md` for env setup).

## Making changes

- Branch from `main`; open a PR against `main`.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must pass.
- UI-affecting changes need before/after screenshots in the PR.
- Keep PRs focused; small is reviewable.

## Reporting bugs / requesting features

Use the issue templates. For security issues, see [SECURITY.md](./SECURITY.md)
— do not open a public issue.

## License

By contributing, you agree your contributions are licensed under Apache-2.0.
```

- [ ] **Step 2: CODE_OF_CONDUCT.md**

```bash
curl -sf https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md -o CODE_OF_CONDUCT.md
head -5 CODE_OF_CONDUCT.md  # verify real content, not an HTML error page
```

If the curl serves HTML, grab the markdown from https://github.com/EthicalSource/contributor_covenant/blob/release/content/version/2/1/code_of_conduct.md instead. Set the contact to `security@vendo.run`.

- [ ] **Step 3: SECURITY.md**

```markdown
# Security Policy

Vendo renders agent-generated UI in a sandboxed iframe and executes tools
against host APIs — security reports are taken seriously.

## Reporting a vulnerability

Email **security@vendo.run**. Do not open a public issue. You'll get an
acknowledgement within 48 hours.

## Supported versions

The latest published minor version of each `@vendoai/*` package.
```

- [ ] **Step 4: Templates + CODEOWNERS**

`.github/CODEOWNERS`:

```
* @yousefh409
```

`.github/ISSUE_TEMPLATE/bug_report.md`:

```markdown
---
name: Bug report
about: Something broken in a @vendoai package or demo
---

**Package/app affected** (e.g. @vendoai/react, demo-bank):

**What happened**

**What you expected**

**Repro steps** (a minimal snippet or repo beats prose)

**Environment**: Node version, framework (Next.js/…), browser
```

`.github/ISSUE_TEMPLATE/feature_request.md`:

```markdown
---
name: Feature request
about: Propose an improvement
---

**Problem** — what can't you do today?

**Proposed solution**

**Alternatives considered**
```

`.github/PULL_REQUEST_TEMPLATE.md`:

```markdown
## What

## Why

## Verification
- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green
- [ ] Screenshots attached (if UI-affecting)
```

- [ ] **Step 5: Rewrite CLAUDE.md as the public version**

Replace the whole file with:

```markdown
# Vendo

Vendo is a devtool that lets a company's users customize its product: an
embedded agent that acts through the host's own API as the user and renders
generated UI in a sandboxed, brand-native surface.

## Layout

- `packages/` — the published `@vendoai/*` libraries (core, server, runtime,
  react, next, shell, components, stage, store, telemetry, cli)
- `apps/` — demo host apps (demo-bank "Maple", demo-accounting "Cadence")
- `examples/` — minimal usage examples
- `docs/` — integration docs

## Commands

- `pnpm install` · `pnpm build` · `pnpm test` · `pnpm typecheck` · `pnpm lint` (turbo-cached)
- `pnpm demo` — run the demo-bank host app (env setup: `apps/demo-bank/README.md`)
- `pnpm demo:accounting` — run the Cadence accounting demo
- `npx @vendoai/cli init <dir>` — install Vendo into a Next.js app

## Rules

- Never commit to `main`; branch and open a PR.
- UI-affecting changes are verified in a real browser with screenshots in the
  PR. Tests and typecheck alone don't count.
- `pnpm build && pnpm test && pnpm typecheck && pnpm lint` must be green
  before any PR.
```

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs: community files and public CLAUDE.md"
```

### Task 7: Banner asset (Option A — approved mockup)

**Files:**
- Create: `assets/banner.svg` (1280×320), `assets/social-preview.png` (1280×640, repo setting upload — not referenced by README)
- Reference mockup: the approved artifact source at `<scratchpad>/vendo-banner-options.html`, Option A block. Brand spec: `/Users/yousefh/orca/workspaces/vendo-web/Brand.md`.

- [ ] **Step 1: Fetch fonts**

```bash
S=/private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-open-source-ready/19b20ed6-dd35-4c02-b699-3074d5e628d7/scratchpad
mkdir -p $S/banner && cd $S/banner
curl -sfL "https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip" -o inter.zip && unzip -oq inter.zip -d inter
curl -sfL "https://raw.githubusercontent.com/google/fonts/main/ofl/newsreader/Newsreader-Italic%5Bopsz%2Cwght%5D.ttf" -o newsreader-italic.ttf
ls inter/extras/otf/ 2>/dev/null || find inter -name "Inter-SemiBold*" | head -3
```

Expected: an Inter SemiBold OTF/TTF and the Newsreader italic variable TTF on disk. If URLs 404, find current release URLs (rsms/inter releases page; google/fonts ofl/newsreader) — do not substitute different typefaces.

- [ ] **Step 2: Generate the SVG with text as paths**

```bash
cd $S/banner && npm init -y >/dev/null && npm i opentype.js >/dev/null
```

Write `$S/banner/gen.mjs`:

```js
import opentype from "opentype.js";
import fs from "node:fs";

const inter = await opentype.load(process.argv[2]);      // Inter SemiBold
const news = await opentype.load(process.argv[3]);       // Newsreader Italic

// letter-spacing helper: opentype getPath has no tracking, so lay out per-glyph
function textPath(font, text, x, y, size, tracking) {
  let cursor = x, d = "";
  for (const ch of text) {
    const g = font.charToGlyph(ch);
    d += g.getPath(cursor, y, size).toPathData(2);
    cursor += (g.advanceWidth / font.unitsPerEm) * size + tracking * size;
  }
  return { d, end: cursor };
}

const W = 1280, H = 320;
// Composition per the approved Option A mockup (scaled from 4:1 CSS):
// wordmark 30px @ x=83 (6.5%), tagline 42px, one-liner 15px — scaled ~1.07x for 1280w
const wm = textPath(inter, "vendo", 83, 118, 32, -0.02);
const t1 = textPath(inter, "Your product, ", 83, 172, 45, -0.035);
const t2 = textPath(news, "shaped", t1.end + 4, 172, 45, -0.01);
const t3 = textPath(inter, " to every customer.", t2.end + 4, 172, 45, -0.035);
const sub = textPath(inter, "An embedded agent your customers use to automate work, build views, and connect tools — inside your brand and guardrails.", 83, 212, 16, 0);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#FAFAF8"/>
  <defs>
    <radialGradient id="o1"><stop offset="0" stop-color="#4338CA" stop-opacity=".32"/><stop offset=".72" stop-color="#4338CA" stop-opacity="0"/></radialGradient>
    <radialGradient id="o2"><stop offset="0" stop-color="#818CF8" stop-opacity=".30"/><stop offset=".72" stop-color="#818CF8" stop-opacity="0"/></radialGradient>
    <radialGradient id="o3"><stop offset="0" stop-color="#5ED2EA" stop-opacity=".16"/><stop offset=".70" stop-color="#5ED2EA" stop-opacity="0"/></radialGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="11"/></filter>
  </defs>
  <g filter="url(#blur)">
    <ellipse cx="960" cy="70" rx="218" ry="192" fill="url(#o1)"/>
    <ellipse cx="1113" cy="215" rx="192" ry="176" fill="url(#o2)"/>
    <ellipse cx="806" cy="248" rx="166" ry="152" fill="url(#o3)"/>
  </g>
  <g fill="#17171A">
    <path d="${wm.d}"/>
    <path d="${t1.d}"/><path d="${t2.d}"/><path d="${t3.d}"/>
  </g>
  <g fill="#6E6E73"><path d="${sub.d}"/></g>
</svg>`;
fs.writeFileSync("banner.svg", svg);
console.log("wrote banner.svg", svg.length, "bytes");
```

Run it (substitute the actual font paths found in Step 1):

```bash
node gen.mjs inter/extras/otf/Inter-SemiBold.otf newsreader-italic.ttf
```

NOTE — Newsreader is a variable font; if the italic renders at the default weight extreme, instance it to wght 500 first (`npx fonttools varLib.instancer newsreader-italic.ttf wght=500 opsz=16` — fonttools via `pipx run fonttools` or `pip3 install fonttools`).

- [ ] **Step 3: Render + eyeball against the approved mockup**

```bash
npx -y playwright screenshot --viewport-size=1280,320 "file://$S/banner/banner.svg" $S/banner/banner-check.png
```

Read the PNG. Compare to the approved Option A mockup: porcelain ground, ink text left column, three soft orbs right, italic "shaped", one-liner readable, nothing clipped. Adjust coordinates/sizes in `gen.mjs` and re-run until it matches. If the one-liner overflows the orb field, shorten to end at "…connect tools." — do not shrink below 15px.

**Fallback (only if font tooling is genuinely blocked):** render the approved mockup HTML Option A block with Playwright at 2560×640 and ship `assets/banner.png` @2x instead; README `<img>` width caps it at 1280.

- [ ] **Step 4: Social preview**

```bash
npx -y playwright screenshot --viewport-size=1280,640 "file://$S/banner/banner-social.svg" $S/banner/social-preview.png
```

Make `banner-social.svg` first: copy `gen.mjs` output with `H=640`, content vertically centered (same composition, y-offsets +160). Eyeball it the same way.

- [ ] **Step 5: Move into repo + send for review**

```bash
mkdir -p assets && cp $S/banner/banner.svg assets/banner.svg && cp $S/banner/social-preview.png assets/social-preview.png
```

Send both renders to Yousef (SendUserFile) — banner is UI; he approved the mockup, this confirms the real asset. Proceed to Task 8 while awaiting comment; block the PR merge, not the work.

- [ ] **Step 6: Commit**

```bash
git add assets && git commit -m "feat: launch banner + social preview (brand Option A)"
```

### Task 8: README rewrite

**Files:**
- Rewrite: `README.md`
- Reference: `docs/quickstart.md` (keep it; README links to it), `TELEMETRY.md`

- [ ] **Step 1: Replace README.md entirely**

```markdown
<p align="center">
  <img src="assets/banner.svg" alt="Vendo — your product, shaped to every customer" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-4338CA" alt="License"></a>
  <a href="https://github.com/runvendo/vendo/actions/workflows/ci.yml"><img src="https://github.com/runvendo/vendo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/org/vendoai"><img src="https://img.shields.io/badge/npm-%40vendoai-4338CA" alt="npm"></a>
</p>

Vendo embeds an agent in your product that lets every customer automate their
work, build their own views, and connect their tools — inside your brand and
your guardrails.

- **Automate work** — customers describe workflows; Vendo runs them through
  your product's own API, as the customer, with approval gates you define.
- **Build views** — the agent composes custom UI from your component catalog
  plus generated React, rendered in an egress-jailed sandbox.
- **Connect tools** — Gmail, Slack, Calendar, any MCP server — wired through
  per-tool consent.

## Quickstart

One command inside a Next.js app:

```bash
npx @vendoai/cli init .
```

Add a provider key to `.env.local` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or
`GOOGLE_GENERATIVE_AI_API_KEY`), start your dev server, and the Vendo surface
is live in your product. Full walkthrough: [docs/quickstart.md](docs/quickstart.md).

## Packages

| Package | What it is |
|---|---|
| `@vendoai/cli` | `vendo init` — one-command install into a Next.js app |
| `@vendoai/core` | Manifest schemas, GenUI format, the five platform seams |
| `@vendoai/server` | Provider-agnostic agent server (bring any AI SDK provider) |
| `@vendoai/runtime` | Embedded runtime: tools, automations, MCP client |
| `@vendoai/react` | React provider + `useVendoChat` |
| `@vendoai/next` | `createVendoHandler` route handler + `<VendoRoot>` for Next.js |
| `@vendoai/shell` | The embedded surfaces: tabbed page, overlay, slot |
| `@vendoai/components` | Brand-themeable component catalog |
| `@vendoai/stage` | Realtime voice stage |
| `@vendoai/store` | Durable persistence (PGlite default, Postgres in prod) |
| `@vendoai/telemetry` | Anonymous, opt-out build/dev telemetry |

## Demos

- `apps/demo-bank` — **Maple**, a consumer neobank with Vendo embedded
  (`pnpm demo`)
- `apps/demo-accounting` — **Cadence**, an accounting practice app with
  automations + voice (`pnpm demo:accounting`)
- `examples/` — minimal integration examples

## How it works

The agent acts through your product's OpenAPI surface as the signed-in user.
Generated UI renders in a sandboxed iframe with no network egress; host
components render natively from your catalog. Every mutating action flows
through your permission policy — consent prompts, approval tokens, and judged
guardrails. Deeper docs: [docs/](docs/).

## Telemetry

Build/dev tooling collects anonymous, opt-out usage telemetry — no end-user
data, ever. Details and the opt-out switch: [TELEMETRY.md](TELEMETRY.md).

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE)
```

- [ ] **Step 2: Verify every relative link resolves**

```bash
for f in LICENSE TELEMETRY.md CONTRIBUTING.md SECURITY.md docs/quickstart.md assets/banner.svg; do test -e $f && echo "OK $f" || echo "MISSING $f"; done
```

Expected: all OK. Also verify `docs/quickstart.md` says `npx @vendoai/cli init` (not the local `node packages/...` path) — update it if stale, and check `docs/contracts/`, `docs/host-components.md`, `docs/persistence-and-deploy.md` read publicly (no internal ticket refs; fix inline if trivial, note if larger).

- [ ] **Step 3: Render check**

```bash
npx -y playwright screenshot --viewport-size=1000,2200 "https://github.com/runvendo/vendo/blob/yousefh409/open-source-ready/README.md" $S/readme-check.png
```

(Requires the branch pushed — push first: `git push -u origin yousefh409/open-source-ready`.) Read the screenshot: banner renders, badges load, tables format.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: public launch README"
```

### Task 9: npm-ready package manifests

**Files:**
- Modify: every `packages/*/package.json` except `vendo-sandbox-shims` (stays private).

- [ ] **Step 1: Apply shared publish metadata**

```bash
node -e '
const fs=require("fs");
const pkgs=fs.readdirSync("packages").filter(d=>d!=="vendo-sandbox-shims");
for (const d of pkgs) {
  const p=`packages/${d}/package.json`;
  const j=JSON.parse(fs.readFileSync(p,"utf8"));
  j.version="0.1.0";
  j.repository={type:"git",url:"git+https://github.com/runvendo/vendo.git",directory:`packages/${d}`};
  j.homepage="https://vendo.run";
  j.bugs="https://github.com/runvendo/vendo/issues";
  j.engines={node:">=20"};
  j.publishConfig={access:"public"};
  j.files=j.files||["dist"];
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
}
// private ones still get version bumps for workspace consistency
for (const p of ["packages/vendo-sandbox-shims/package.json"]) {
  const j=JSON.parse(fs.readFileSync(p,"utf8")); j.version="0.1.0";
  fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n");
}'
git diff --stat
```

`publishConfig.access=public` is mandatory — scoped packages default to restricted and the publish fails without it.

- [ ] **Step 2: Per-package `files` audit**

For each package, check what the build emits beyond `dist/` (e.g. `vendo-shell` copies `styles.css` into dist — fine; `vendo-cli`'s `bundle-assets.mjs` — find its output dir):

```bash
cat packages/vendo-cli/scripts/bundle-assets.mjs | head -30
pnpm --filter @vendoai/cli build && ls packages/vendo-cli/dist | head
```

Add every runtime-needed dir to that package's `files`. CLI also needs its template/codemod assets — confirm they land inside `dist/` or add their dir.

- [ ] **Step 3: CLI dependency audit (the private-dep problem)**

`@vendoai/cli` lists `@vendoai/sandbox-shims` (private) in `dependencies`. Check the vite config: if the CLI bundle inlines workspace deps, move the inlined ones to `devDependencies`; if it externalizes them, sandbox-shims content must be shipped via `bundle-assets.mjs` output instead — verify which, then ensure the published manifest lists **no private package** under `dependencies`:

```bash
grep -n "external\|rollupOptions" packages/vendo-cli/vite.config.* 
node -e "const j=require('./packages/vendo-cli/package.json'); console.log(j.dependencies)"
```

- [ ] **Step 4: Build + gates**

```bash
pnpm build && pnpm test && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: npm-ready manifests — 0.1.0, files, repository, publishConfig"
```

### Task 10: Bundle fluidkit into @vendoai/shell

The shell imports fluidkit via dynamic `import("fluidkit")` (enhancement layer with graceful fallback) plus type-only imports, and depends on it via `file:../../vendor/fluidkit-*.tgz` — which cannot ship to npm.

**Files:**
- Modify: `packages/vendo-shell/package.json`, create `packages/vendo-shell/tsup.config.ts`
- Test: existing `packages/vendo-shell/src/components/fluid-thinking-absent.test.tsx` keeps passing.

- [ ] **Step 1: Switch the build to tsup with fluidkit inlined**

```bash
pnpm --filter @vendoai/shell add -D tsup
```

`packages/vendo-shell/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  // fluidkit ships as a file: tarball, so it must be inlined into the dist;
  // everything else stays external for the consumer's bundler to dedupe.
  noExternal: ["fluidkit"],
  onSuccess: "cp src/styles.css dist/styles.css",
});
```

Update `packages/vendo-shell/package.json`: `"build": "tsup"`; move `"fluidkit"` from `dependencies` to `devDependencies` (tsup inlines it at build time). Keep the exports map as-is (paths unchanged: `dist/index.js`, `dist/index.d.ts`, `dist/styles.css`).

- [ ] **Step 2: Build and inspect**

```bash
pnpm --filter @vendoai/shell build
grep -c "fluidkit" packages/vendo-shell/dist/index.js || true
node -e "const s=require('fs').readFileSync('packages/vendo-shell/dist/index.js','utf8'); console.log('has import(\"fluidkit\")?', /import\(['\"]fluidkit['\"]\)/.test(s))"
```

Expected: no bare `import("fluidkit")` remains (tsup rewrites the dynamic import to the inlined chunk). If tsup left it external, add `splitting: false` or switch the dynamic import to a static-import-behind-lazy pattern — the absent-fallback test defines the contract either way.

- [ ] **Step 3: Tests**

```bash
pnpm --filter @vendoai/shell test && pnpm test
```

Expected: green, including `fluid-thinking-absent.test.tsx`.

- [ ] **Step 4: Visual sanity in a demo**

Boot `pnpm demo`, trigger the thinking indicator, confirm the metaball droplets still animate (screenshot for the PR — UI-affecting build change).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "build(shell): bundle fluidkit into dist; no file: dep in published package"
```

### Task 11: Node-loadability smoke — pack and import every package

The recorded blocker: dists not Node-loadable pre-NodeNext fixes. This task proves each published tarball imports cleanly in plain Node.

**Files:** whatever the failures point at (tsconfig `moduleResolution`, missing `.js` extensions in relative imports, exports maps).

- [ ] **Step 1: Pack everything into a tarball dir**

```bash
S=/private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-open-source-ready/19b20ed6-dd35-4c02-b699-3074d5e628d7/scratchpad
mkdir -p $S/tarballs && rm -f $S/tarballs/*.tgz
pnpm -r --filter './packages/*' --filter '!@vendoai/sandbox-shims' exec pnpm pack --pack-destination $S/tarballs
ls $S/tarballs
```

Expected: 11 tarballs. (pnpm pack rewrites `workspace:*` to real versions — verify with `tar -xzOf $S/tarballs/vendoai-core-0.1.0.tgz package/package.json | grep -A2 dependencies | head`.)

- [ ] **Step 2: Import each from a clean Node project**

```bash
mkdir -p $S/smoke && cd $S/smoke && npm init -y >/dev/null
npm i $S/tarballs/*.tgz react react-dom next 2>&1 | tail -2
for m in core server runtime react next shell components stage store telemetry; do
  node --input-type=module -e "await import('@vendoai/$m'); console.log('OK @vendoai/$m')" \
    || echo "FAIL @vendoai/$m";
done
node --input-type=module -e "await import('@vendoai/next/client'); console.log('OK next/client')"
npx vendo --help >/dev/null && echo "OK cli bin" || echo "FAIL cli bin"
```

React-flavored packages may legitimately fail on a missing DOM — distinguish resolution errors (`ERR_MODULE_NOT_FOUND`, `ERR_PACKAGE_PATH_NOT_EXPORTED` = our bug) from environment errors (`window is not defined` = fine, note it).

- [ ] **Step 3: Fix what fails**

Typical fixes, applied per failing package: `"moduleResolution": "NodeNext"` + `"module": "NodeNext"` in its tsconfig and `.js` extensions on relative imports; missing subpath in `exports`; a dep that should be a peer. Re-run Step 1-2 after each fix until all green.

- [ ] **Step 4: Full gates + commit**

```bash
pnpm build && pnpm test && pnpm typecheck && pnpm lint
git add -A && git commit -m "fix: Node-loadable dists for all published packages"
```

### Task 12: CI + release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: ci.yml**

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
      - run: pnpm typecheck
      - run: pnpm lint
```

- [ ] **Step 2: release.yml**

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          registry-url: https://registry.npmjs.org
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm test
      - run: pnpm -r --filter './packages/*' publish --no-git-checks --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

(`vendo-sandbox-shims` is `private: true`, so `pnpm -r publish` skips it automatically.)

- [ ] **Step 3: Validate + commit**

```bash
npx -y action-validator .github/workflows/ci.yml .github/workflows/release.yml 2>/dev/null || echo "validator unavailable — eyeball the YAML"
git add .github/workflows && git commit -m "ci: build/test on PRs, tag-triggered npm release"
```

After push, confirm the CI run goes green on this PR before Task 14.

### Task 13: Fresh-machine E2E — the acceptance bar

`vendo init` into a brand-new Next.js app using only the packed tarballs and one provider key, verified in a real browser.

- [ ] **Step 1: Fresh Next.js app**

```bash
S=/private/tmp/claude-501/-Users-yousefh-orca-workspaces-flowlet-open-source-ready/19b20ed6-dd35-4c02-b699-3074d5e628d7/scratchpad
cd $S && npx -y create-next-app@latest e2e-host --ts --app --no-eslint --no-tailwind --no-src-dir --import-alias "@/*" --use-npm --yes
```

- [ ] **Step 2: Install tarballs + run init**

```bash
cd $S/e2e-host && npm i $S/tarballs/*.tgz
npx vendo init .
```

Expected: extractor runs (deterministic without a key; with `ANTHROPIC_API_KEY` exported, the LLM path), route handler + provider wrap + `.env.example` + sandbox assets created. Capture full output for the PR.

- [ ] **Step 3: Boot with a real key + browser verification**

```bash
echo "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" > .env.local
npm run dev &
```

Then with Playwright/Chrome: open http://localhost:3000, open the Vendo surface, send a message, confirm a rendered response. Screenshot: surface open + response rendered. This is the money shot for the PR.

- [ ] **Step 4: Record + clean up**

Kill the dev server. Save screenshots to the scratchpad for the PR body. If init or boot fails, fix in the relevant package, rebuild, re-pack (Task 11 Step 1), and repeat — this task gates the launch.

### Task 14: Final sweep + PR

- [ ] **Step 1: Delete the launch spec/plan (last internal docs)**

```bash
git rm docs/superpowers/specs/2026-07-05-oss-launch-readiness-design.md docs/superpowers/plans/2026-07-05-oss-launch-readiness.md
rmdir docs/superpowers/specs docs/superpowers/plans docs/superpowers 2>/dev/null || true
git commit -m "chore: remove launch working docs (live in git history)"
```

- [ ] **Step 2: Full gates one last time**

```bash
pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint
git status --porcelain   # expect empty
```

- [ ] **Step 3: Final flowlet/internal sweep**

```bash
grep -rn -i "flowlet\|infisical" --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' --include='*.yaml' . | grep -v node_modules | grep -v pnpm-lock
```

Expected: only intentional frozen legacy keys from Task 4 (each with its comment).

- [ ] **Step 4: Push + PR**

```bash
git push -u origin yousefh409/open-source-ready
gh pr create --title "Open-source launch readiness" --body "$(cat <<'EOF'
## What
Everything to flip runvendo/vendo public and publish @vendoai/* 0.1.0: tree cleanup (gmail demo, internal artifacts, docs-site out), Apache-2.0 + NOTICE, community files, launch README + brand banner, npm-ready manifests + Node-loadable dists, fluidkit bundled into shell, CI + tag release workflows.

## Verification
- build/test/typecheck/lint green (CI on this PR)
- Fresh-machine E2E: create-next-app + tarball install + `vendo init` + browser boot with only ANTHROPIC_API_KEY — screenshots below
- Banner + README render screenshots below

## Screenshots
(banner, README render, E2E boot)

## Launch checklist (post-merge, Yousef)
1. Register/verify @vendoai npm org; add NPM_TOKEN repo secret
2. Rotate any credential flagged by the history secret scan (Task 1 report)
3. Merge; flip repo public
4. `gh repo edit runvendo/vendo --description "Embed an agent in your product that lets every customer automate work, build views, and connect their tools — inside your brand and your guardrails." --add-topic ai --add-topic agents --add-topic generative-ui --add-topic react --add-topic nextjs --add-topic sdk --add-topic typescript`
5. Upload assets/social-preview.png as the repo social image (Settings → General)
6. Tag v0.1.0 → release workflow publishes to npm
7. Create runvendo/docs from docs-site (git history has it), point Mintlify there, flip public
8. Point vendo.run at the repo; create security@vendo.run alias

https://claude.ai/code/session_01C3iN3nkdQq7HC3AuFeTcED
EOF
)"
```

- [ ] **Step 5: Report to Yousef**

Summarize: what shipped, E2E result, secret-scan verdict, what's left on his checklist. Do not merge.

---

## Self-review notes

- Spec §1–§8 all map to tasks 2,3,5,6,7-8,9-12,13,14 respectively; secret scan (spec §6) is Task 1; flowlet purge (spec §6) is Task 4.
- docs/ keepers (`quickstart.md`, `contracts/`, `host-components.md`, `persistence-and-deploy.md`) are audited in Task 8 Step 2.
- Banner coordinates in Task 7 are starting values; Step 3's eyeball loop is the real contract (match the approved mockup).
- Task 11 owns the "dists not Node-loadable" known blocker; exact fixes depend on the failure output by design.
