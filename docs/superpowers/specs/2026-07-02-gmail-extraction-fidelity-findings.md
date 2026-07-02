# `flowlet init` on the Gmail clone — extraction fidelity findings

Second real customer run of the ENG-197 extractor (after demo-bank's ground truth) — and the
first against a non-Next, non-Tailwind, JavaScript app (CRA 5 + styled-components + JSX).
Verbatim runs below; `.flowlet/` was then hand-fixed to ground truth (the README in
`.flowlet/` says the outputs are yours to edit — this is that, honestly documented).

## Run 1 — as-is (`node packages/flowlet-cli/dist/cli.js init apps/gmail`)

```
framework: vite   tailwind: none   openapi: none
theme.json: written (0 vars scanned)
  DEFAULTED (edit by hand): accent, background, surface, mutedText, text, radius, fontFamily
tools.json: 0 tools (source: none)
  warning: no OpenAPI spec and no scannable routes found — write .flowlet/tools.json by hand
components/: 0/0 candidates wrapped
```

## Run 2 — spec copied to the app root (`init --force`)

```
framework: vite   tailwind: none   openapi: .../apps/gmail/openapi.json
theme.json: written (0 vars scanned)
tools.json: 7 tools (source: openapi)
components/: 0/0 candidates wrapped
```

## Scorecard

| Artifact | Result | Verdict |
| --- | --- | --- |
| tools.json (with spec found) | 7/7 operations, names, schemas, descriptions verbatim; annotations exactly right (delete → `dangerous`, send/read/star → `mutating`, reads free) | **Excellent** — the deterministic OpenAPI path is production-quality |
| tools.json (as-is) | 0 tools; the app keeps its spec at `src/openapi.json` (CRA's ModuleScopePlugin forbids the client importing a root-level spec), which is not in `detect.ts`'s candidate list | **Miss** — see gap 2 |
| theme.json | All 7 slots defaulted (correctly flagged). The app styles with styled-components; there are no CSS custom properties or Tailwind config to scan | **Expected miss** — honest, fails loud not wrong |
| components/ | 0 candidates in an app with ~20 components | **Miss** — see gap 1 |
| framework detection | `vite` — wrong; this is CRA (react-scripts). Detect keyed off the `vite` devDependency that exists only for the *Flowlet sandbox bundle* build | **Wrong but harmless here** — see gap 3 |

## Gaps worth CLI backlog entries

1. **Component scan is `.tsx`-only** (`scan.ts` filters `rel.endsWith(".tsx")`). A JS/JSX
   codebase — most CRA-era apps — yields zero candidates before the LLM ever runs. Adding
   `.jsx` (and arguably `.js` with a JSX heuristic) to the filter is the whole fix.
2. **OpenAPI detection candidates** miss `src/openapi.json`. CRA apps are pushed toward
   keeping importable assets under `src/` by ModuleScopePlugin, so this location will recur
   for this app class.
3. **Framework detection trusts dependencies over layout.** Installing Flowlet's own sandbox
   pipeline (vite devDep) flipped the verdict to `vite` even though `react-scripts` is right
   there. Preferring config-file evidence (`craco.config.js`, `react-scripts` in scripts)
   over dep presence would fix it. Consequence today is only cosmetic (theme/tool scans
   don't branch on it for this app), but wrong labels erode trust in the report.
4. **Styled-components theme extraction doesn't exist** (known: extractor targets Tailwind /
   CSS custom props). The interesting future path is scanning styled-components template
   literals for recurring color/font/radius tokens.
5. **Generated components/ still targets the pre-ENG-184 wrapper pattern** (own
   `entry.ts` + `window.__FLOWLET_HOST__` assembly). This app registered its components via
   the new 3-file path (`hostComponent`/`bindHostImpl`/`installFlowletHost`) instead; had
   the extractor emitted candidates, they would have come out in the deprecated shape.
   (Moot here because of gap 1, but it will bite the next TSX customer.)

## Hand-fixes applied

- `theme.json`: defaults replaced with the app's real brand (Gmail blue `#1A73E8`,
  `#202124`/`#5F6368` text, Roboto stack, 8px radius) — the same tokens as
  `src/flowlet/brand.json`, which feeds the shell, sandbox and agent brand guidance.
  The two files stay in sync by hand; `.flowlet/theme.json` can't be the client's import
  source (ModuleScopePlugin again).
- `tools.json`: kept verbatim from run 2 (it was correct); the temporary root-level spec
  copy was removed afterwards — `src/openapi.json` stays the single source.
- `components/`: left as-emitted (none). The real registrations live in
  `src/flowlet/host-components.js` + `flowlet-sandbox/impls.jsx` per docs/host-components.md.
