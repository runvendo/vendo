# ENG-184 Brand-Native Audit — Findings

- **Date:** 2026-07-02
- **Scope:** Phase 1 audit only. No product code changed. Evidence in `audit/*.png`.
- **Method:** Code inventory of every lever (tool, prompt, descriptors, theme pipeline, stage runtime) plus visual verification. The live agent could not run (see F3), so representative `GeneratedPayload`s were replayed through the **exact production pipeline** — real `createStage`/`connectStage`/`createGenUISession`, the real `public/flowlet/react-runtime.js` + `components-sandbox.js`, real `brandToCssVars(mapleBrand)` — from a scratchpad harness. The only synthetic part is the payload JSON itself (normally authored by the model). Payloads follow the system prompt's own instructions.

## Baseline: what "Maple-native" means

`01-host-home.png`, `02-host-insights.png`: Inter, graphite-on-warm-paper, white cards with hairline borders and 16px radius, letter-spaced uppercase section labels, monochrome single-stroke charts, muted slate/plum/rust categorical palette, tabular numerals, generous but disciplined spacing.

## Verdict

Generated UI today is not "AI-generic vs host-native" — it is **broken, then unstyled, then unbranded**, in that order. Three foundation bugs mean nothing renders correctly at all; once those are fixed, the styling foundation is missing; once *that* exists, no lever tells the model (or the theme mapping) what Maple looks like. `07-sandbox-clock.png` (TimeOfDayClock: hand-authored, self-styled, reads `--flowlet-*`) proves the sandbox can produce host-quality output — everything else falls short of it.

---

## P0 — blockers (nothing brand-related matters until these are fixed)

### F1. The React shim strands the components bundle — every render_view view is a blank stage
The built shim (`react-runtime.js`, from `packages/flowlet-stage/tests/browser/sample-bundle/react-shim.ts`) ends with `export { createRoot, default, jsx, jsxs }` — `export * from "react"` produces **nothing** through the CJS interop. The externalized components bundle opens with `import E, { forwardRef, useState, PureComponent, … } from "react"` plus `Fragment` from `react/jsx-runtime` and `createPortal`/`flushSync` from `react-dom`. The import fails at module evaluation → `loadBundle` throws → the **whole render pass dies after `ui/initialize` acks** → permanently blank stage. Reproduced with the exact demo assets; console: `The requested module 'react' does not provide an export named 'PureComponent'`.
- **Why tests miss it:** the browser gates exercise sample bundles that only use the four exported names, never the real components bundle.
- **Lever:** shim entry — explicit named re-exports of the full React/ReactDOM surface (or fix interop). Add a gate that imports the *real* `components-sandbox.js` in the sandbox.

### F2. Stage auto-size is dead code — views clip to the default iframe height
`runtime.ts:399` posts `{type:"resize", height}`; **no code anywhere consumes it** (grep: only producer). The iframe is created with `width:100%;min-height:1px` and no height → ~150px default, so any real view is clipped (`05` was captured with a harness-only resize listener; without it the dashboard shows two truncated lines). No shell/app CSS compensates.
- **Lever:** consume `resize` in `stage-host.ts`/`FlowletStage` (or size via ResizeObserver on the host side).

### F3. Anthropic API credits exhausted — the demo agent cannot run at all
`04-api-credit-error.png`. The Infisical `ANTHROPIC_API_KEY` returns "credit balance is too low"; no local key; the agent is hardwired to the Anthropic provider (other keys in Infisical don't help without code changes). **Billing — needs Yousef.** Until topped up, live model-authored views (the other half of this audit: component choice, layout judgment, payload quality) cannot be assessed.

---

## P1 — the sandbox has no styling foundation (why output reads "AI-generic")

### F4. OpenUI's base CSS never ships into the sandbox — the entire catalog renders as bare HTML
`@openuidev/react-ui/index.css` is imported only in `src/index.ts`; the sandbox bundle entry (`bundle/entry.ts`) imports `../src/impls` directly, so **no CSS exists in `dist-sandbox/` or `public/flowlet/`**. Result (`05`, `06`, `07`): Card = plain text (no surface/border/radius/padding), Table = default HTML table, Form = raw browser inputs with labels jammed against fields, Callout = invisible (plain text), Chart = recharts with collapsed layout and clipped axes. Compare `10-host-side-catalog.png` (host-side with CSS + ThemeProvider): same components render clean. This was flagged in the F4 design ("must include it, or components render unstyled") and got lost.
- **Lever:** import the CSS in the bundle entry + inline it into the bundle (e.g. css-injected-by-js) or ship/inject a `style.css` alongside; the srcdoc CSP already allows `style-src 'unsafe-inline'`.

### F5. The srcdoc has zero baseline styles — generated markup defaults to Times New Roman
`buildSrcdoc` emits a bare `<html><body>`: no margin reset, no `font-family`/`color`/`background` wired to the injected `--flowlet-*` vars. Any plain markup — which is exactly what generated novel components emit — renders serif, default-margin, unthemed (`09-sandbox-novel-bare.png` is pure 1996). The vars are injected on `:root` but **nothing consumes them by default**; only components that explicitly reference them (TimeOfDayClock, Text's color) pick them up.
- **Lever:** a small baseline stylesheet in the srcdoc: `body { margin:0; font-family:var(--flowlet-font); color:var(--flowlet-fg); }` etc.

### F6. Maple's brand tokens poison the font pipeline inside the iframe
`mapleBrand.fontFamily = "var(--font-inter), ui-sans-serif, …"` — a **host CSS var reference**, violating the BrandTokens contract ("fully resolved primitives; no var() references" — the zod schema enforces this for colors but not fonts). Inside the opaque-origin iframe `--font-inter` doesn't exist, and a `var()` referencing an undefined custom property makes the whole `font-family` declaration invalid-at-computed-value-time → **default serif**, not even the fallback stack. Separately, Inter's font *files* are never provisioned into the sandbox (`font-src data:` only), so even a resolved stack falls back to system fonts.
- **Levers:** (a) tighten the `fontFamily` schema to reject `var(`; (b) fix Maple's brand to a resolved stack; (c) decide the sandbox font-delivery story (accept system stack short-term; data:-URI font provisioning later). Feeds ENG-197's extractor contract.

---

## P2 — brand-fidelity levers (the actual ENG-184 surface, once P0/P1 land)

### F7. Codegen is told nothing about the brand
The system prompt (`apps/demo-bank/src/flowlet/agent.ts`) and the `render_view` tool description contain **zero style guidance**: no palette, no typography, no spacing/density rules, no mention that `--flowlet-*` vars exist and should be used in generated component styles. Predictable result (`08-sandbox-novel.png`): a competent but fully off-brand component — indigo→purple gradient, Tailwind grays, `system-ui` — next to Maple's graphite/paper. The model *cannot* match a brand it never sees.
- **Lever (highest ROI in this epic):** a brand section in the prompt generated from `BrandTokens` (values + usage rules: "use var(--flowlet-accent) / surface / fg-muted; radius var(--flowlet-radius); no gradients; no emoji-style palettes"), mirrored briefly in the tool description. Later: few-shot examples + a validation/repair pass (the epic's compile/a11y check).

### F8. The OpenUI theme mapping is too thin to carry the brand
`mapBrandToTheme` maps colors/fonts/radius but: **charts get no palette** (recharts default blues — visible in `05` and even host-side `10`), no spacing/density tokens, `Chart` impl hardcodes `width:400 height:300` (non-responsive), renders its title as a raw `<h3>`, and pie/line/area inherit the same defaults. Maple's charts are monochrome + muted slate/plum/rust.
- **Lever:** derive a categorical palette from BrandTokens (accent + neutral ramp) and pass it through the Chart wrapper; responsive sizing; themed title typography. May need a `BrandTokens` extension (chart palette) — coordinate with contracts-freeze.

### F9. Layout primitives can't express the host's spacing rhythm
Stack/Row/Grid: hardcoded `8px` default gap, no padding/surface/alignment/wrap options. Text: one style — no size/weight/muted/uppercase-label variants (it only sets `color`). There is no Divider, Spacer, or Section. So even a well-instructed model can't reproduce Maple's density and hierarchy without hand-rolling everything as novel code (the off-brand path). Grid column labels wrap badly ("Subscripti ons" in `05`).
- **Lever:** enrich primitive props (token-scaled gap/padding, Text variants incl. the uppercase muted label style, a Surface/Panel primitive that *is* the Maple card).

### F10. Host-component reuse is an empty seam — the biggest brand-native lever is unfed
The stage resolves `prewired → host bundle → generated`, but the "host" catalog **is** `@flowlet/components` (generic OpenUI); **zero Maple components are registered**. Meanwhile demo-bank has exactly the components users would want the agent to reuse: `account-card`, `transaction-row`, `sparkline`, `donut`, `area-trend`, `cashflow-bars`, `status-timeline`, `badge`, `count-up`. This is ENG-186's absorbed scope and the single highest-leverage path to "looks like the host built it" — real host components are on-brand by construction.
- **Lever:** wrap a starter set (AccountCard, TransactionRow, Sparkline, Donut, Badge) as descriptor+impl pairs compiled into the sandbox host bundle, registered with `source:"host"` descriptors the prompt lists. Also the proving ground for the registration API + validation this epic owes. Blocked-by note: ENG-197 will eventually *extract* these; hand-wrapping in demo-bank now is the pattern-proof.

### F11. Library coverage gaps push the model into freeform codegen for routine asks
Current catalog (16): Card, Table, Chart(bar/line/area/pie), Form (inert), Accordion, Carousel, Callout, Tags, Steps, List, Image, ImageGallery, Markdown, CodeBlock, Tabs, TimeOfDayClock + 5 primitives. Missing for typical banking/dashboard requests: **stat/KPI tile** (the most common dashboard atom), **progress/budget bar**, **donut-with-legend**, **sparkline**, **timeline/feed**, **key-value detail card** (for "show me this transaction"), **any action/button affordance** (only generated code can `dispatch` — the catalog is 100% read-only), **empty/error/loading states** (only the bare Skeleton primitive), currency/number formatting conventions. Every gap = the model hand-rolls a novel component = the off-brand path (F7).
- **Lever:** targeted catalog expansion, prioritized by what demo prompts actually need (KPI tile, progress, donut+legend, key-value, sparkline first).

---

## P3 — polish once the above land

- **F12. Approval prompt is unstyled host chrome:** `SandboxStage`'s inline `alertdialog` (yellow border, default buttons) breaks brand on the host side of the fence; the shell already has a styled `ApprovalCard` that isn't used here.
- **F13. Fixed-width components:** OpenUI `Card width="standard"`, Chart 400×300 — views don't adapt to the thread column.
- **F14. Working today, keep:** emoji stripping (`stripEmojiDeep`), the Reveal entrance animation, server-side JSX/TS compile with model-correctable errors, per-node error containment, and the whole capability/policy chokepoint — none of these showed brand or correctness issues in the audit.

## Suggested sequencing (for review, not started)

1. **F1 + F2** (render at all) → 2. **F4 + F5 + F6** (styled at all) → 3. **F7 + F8** (branded) → 4. **F10 + F11 + F9** (host-native + coverage) → 5. **F12/F13**. F3 (credits) gates re-running the live-model half of the audit — worth doing right after F1/F2 so we can finally see *model-authored* payload quality (component choice, layout judgment), which this audit could only approximate.

## Coordination notes

- F1/F2/F4/F5 live in `flowlet-stage` build/runtime + `flowlet-components` bundle — inside this worktree's lane.
- F7 touches the demo system prompt (`apps/demo-bank/src/flowlet/agent.ts`) and the `render_view` tool description in `packages/flowlet-agent` — **overlaps eng-202-host-tools' package; coordinate through the orchestrator.**
- F6/F8 may extend the `BrandTokens` schema — **coordinate with contracts-freeze.**

## Evidence index

| File | What it shows |
|---|---|
| `01-host-home.png`, `02-host-insights.png` | Maple brand baseline |
| `03-vendo-empty.png` | Vendo surface (host chrome is fine) |
| `04-api-credit-error.png` | F3: agent cannot run |
| `05-sandbox-dashboard.png` | F4/F5/F6/F8/F9: catalog dashboard through the real pipeline (with harness-only F1/F2 workarounds so it renders at all) |
| `06-sandbox-form.png` | F4: Form = raw browser inputs |
| `07-sandbox-clock.png` | The ceiling: token-aware self-styled component is near host-native; unstyled Callout right below it |
| `08-sandbox-novel.png` | F7: model-style novel component — polished but fully off-brand |
| `09-sandbox-novel-bare.png` | F5: unstyled generated markup = Times New Roman |
| `10-host-side-catalog.png` | Same catalog host-side with CSS+theme: the delta to `05`/`06` is sandbox provisioning |
