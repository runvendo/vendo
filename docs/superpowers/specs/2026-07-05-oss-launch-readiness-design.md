# Vendo OSS Launch Readiness — Design

Date: 2026-07-05
Status: Approved by Yousef
Branch: `yousefh409/open-source-ready` (one launch PR)

## Goal

Make `runvendo/vendo` ready to flip public and publish to npm: branding, README,
licensing, community files, tree cleanup, npm-loadable dists, CI, and a verified
fresh-machine install story.

## Locked decisions

- **Repo strategy:** flip this repo public as-is, full history included. The
  history contains internal specs/plans and the vendored unlicensed Gmail clone;
  Yousef accepted this trade-off explicitly (2026-07-05) after being shown the
  copyright-exposure risk. The Gmail clone is deleted from the working tree
  going forward.
- **License:** Apache-2.0.
- **Scope:** full launch — repo readiness *and* npm publish readiness (ENG-198's
  `vendo publish` cloud command stays stubbed; that is a product feature, not
  npm publishing).
- **Tree:** demo apps (demo-bank, demo-accounting) stay as living examples.
  All other internal material leaves the tree.
- **Banner:** Option A — liquid hero, single light (porcelain) asset. Mockup
  approved by Yousef from the banner-options artifact.
- **Work shape:** one mega-PR on this branch.

## 1. Tree cleanup

Delete from the working tree (history keeps them; that is accepted):

- `apps/gmail/` — vendored from an unlicensed upstream ("do not ship or
  publish"); also remove the `demo:gmail` root script and all references.
- `audit/`, `verification/`, `previews/`, `private/`, root `motion*.gif`/`.mp4`.
- `docs/superpowers/` (all internal specs/plans, this file included at the end)
  and `docs/PRD.md` (internal Notion snapshot).
- `docs-site/` — moves to a new `runvendo/docs` repo (created private, flipped
  public at launch; Mintlify re-pointed there).

Rewrites:

- Root `package.json`: drop Infisical-coupled scripts; demos run on plain
  `.env` files with committed `.env.example`s and README instructions.
- `scripts/` (e.g. `composio-connect.mjs`): make env-driven or delete.
- `CLAUDE.md`: rewrite as a public contributor version — build commands,
  layout, verification norms. No internal standing rules or names.
- `vendor/fluidkit-*.tgz` **stays** — our own IP, a build-time dependency of
  `@vendoai/shell` (see §4 for how it ships to npm).

## 2. Licensing

- `LICENSE` (Apache-2.0, "Copyright 2026 Vendo") and a minimal `NOTICE` at root.
- `"license": "Apache-2.0"` in all 13 package.jsons (root + 12 packages) and
  the demo apps.
- No per-file headers (can be added later if wanted).
- Execution step: audit attribution obligations for wrapped third-party code
  (OpenUI/Crayon in `vendo-components`, anything vendored in sandbox shims) and
  add NOTICE entries as required.

## 3. README + branding

- Banner Option A as a real SVG with **text converted to paths** (immune to
  GitHub image font restrictions), stored under `assets/`. Composition per
  Brand.md: porcelain canvas, lowercase `vendo` wordmark (Inter 600), headline
  "Your product, *shaped* to every customer." with the Newsreader-italic word,
  one-liner, three-orb liquid field at Present intensity. Static first; subtle
  orb drift is optional (GitHub renders CSS animation inside SVG).
- README structure: banner → badges (license, CI, npm once live, docs) →
  one-liner → three-bullet "what is Vendo" (automate work / build views /
  connect tools) → quickstart (`npx @vendoai/cli init`) → packages table →
  demo apps → docs link → telemetry note (opt-out, links TELEMETRY.md) →
  contributing → license.
- GitHub repo metadata (set at launch): description "Embed an agent in your
  product that lets every customer automate work, build views, and connect
  their tools — inside your brand and your guardrails.", topics
  (ai, agents, generative-ui, react, nextjs, sdk, typescript, embedded-ai),
  social-preview image derived from the banner.

## 4. npm publish readiness

- Version all publishable packages `0.1.0`.
- Fix dists so packages load in Node: proper `exports` / `types` / `files`,
  NodeNext-compatible resolution. (Known blocker from provider-agnostic work:
  core dist not Node-loadable, vite-bundled bins.)
- fluidkit: **bundle into `@vendoai/shell`'s dist** (noExternal) so no `file:`
  dependency leaks into the published package. Publishing fluidkit as its own
  npm package is future work.
- `@vendoai/sandbox-shims` stays `private: true`; verify nothing published
  needs it at runtime — bundle it in if so.
- `workspace:*` deps resolve to real versions via pnpm publish.
- CI: `.github/workflows/ci.yml` (install, build, test, typecheck, lint on PRs
  and main) and a tag-triggered `release.yml` running `pnpm -r publish` with an
  `NPM_TOKEN` secret. Changesets deferred.
- npm side (Yousef, at launch): register/verify the `@vendoai` org, create the
  token, add it to repo secrets.

## 5. Community files

`CONTRIBUTING.md` (dev setup, PR conventions), `CODE_OF_CONDUCT.md`
(Contributor Covenant), `SECURITY.md` (contact: security@vendo.run — alias
needs creating), `.github/ISSUE_TEMPLATE/` (bug, feature),
`.github/PULL_REQUEST_TEMPLATE.md`, `CODEOWNERS` (@yousefh409).

## 6. Code cleanup

- Purge remaining "flowlet" references from packages/apps source and configs
  (~5 package content refs plus app/docs strays). Frozen historical docs are
  deleted anyway per §1.
- Secret scan over the working tree **and full history** (e.g. gitleaks).
  History ships regardless, but any live credential found is rotated before
  the repo flips public.
- Keep `TELEMETRY.md`; README surfaces the opt-out prominently.

## 7. Verification

- `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint` all green.
- Fresh-machine E2E (the acceptance bar): `npm pack` every publishable package,
  install the tarballs into a brand-new Next.js app outside the monorepo, run
  `vendo init`, boot in a real browser with only `ANTHROPIC_API_KEY`, and
  attach screenshots to the PR.
- README/banner render check on the GitHub branch view before merge; banner is
  UI and gets Yousef's review in the PR (mockup already approved).

## 8. Launch checklist (post-merge, Yousef)

1. Register/verify `@vendoai` npm org; add `NPM_TOKEN` to repo secrets.
2. Merge the PR; flip the repo public.
3. Set repo description, topics, social-preview image.
4. Tag `v0.1.0` → release workflow publishes to npm (or run manually).
5. Create `runvendo/docs` from `docs-site/`, point Mintlify at it, flip public.
6. Point vendo.run at the GitHub repo; create security@vendo.run alias.
7. Optional follow-ups: Scarf registration, per-file license headers,
   changesets, publishing fluidkit standalone.

## Out of scope

- ENG-198 `vendo publish` cloud implementation.
- History rewrite / repo re-creation (explicitly declined).
- Publishing fluidkit as a standalone package.
- CLA tooling (Apache-2.0 inbound=outbound is fine for now).
