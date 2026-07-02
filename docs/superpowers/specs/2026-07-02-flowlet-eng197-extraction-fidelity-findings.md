# ENG-197 extraction-fidelity findings

> **Post-review addendum (dual review, 2026-07-02).** Both reviewers independently found the original annotation inference unsafe, and it was: the generated demo-bank tools.json marked the integrations GET (which calls `connect()`) and the poll GET (which fires Slack) as `mutating:false` — live approval bypasses. The extractor now FAILS CLOSED: route-scan tools are all `mutating:true` (an LLM-read surface never grants auto-allow; the developer relaxes read-only tools by hand), OpenAPI GETs auto-allow only with read-shaped names, and every LLM-reported (path, method) is cross-checked against the verbs the handler actually exports. Also fixed post-review: absolute bundle entry + `publicDir:false` (host-root builds work), fontFamily var() resolution with injection hardening and frozen-schema validation, per-artifact publish messaging, temperature 0, repair-loop guard. The ground truth below was REGENERATED with these fixes: theme now defaults `accent` **and** `fontFamily` (no `var()` leak), tools.json has **0/23** auto-allowed tools, 6/25 components wrapped, and the bundle builds from the host root. §1–2 tables/notes describe the pre-fix run where marked.

- **Issue:** ENG-197 — one-click dev tool (`@flowlet/cli`, `flowlet init` + `flowlet publish` stub)
- **Date:** 2026-07-02
- **Ground truth:** `flowlet init apps/demo-bank` (Anthropic `claude-sonnet-4-6`, key via Infisical), output committed at `apps/demo-bank/.flowlet/`
- **Verification of generated output:** demo-bank `tsc --noEmit` passes with `.flowlet/` included; the emitted sandbox bundle builds via `.flowlet/components/vite.config.mts` + `flowletHostPreset` (167 kB host-bundle, not committed); `tools.json` validates against the frozen `@flowlet/core` zod schemas AND the committed JSON Schemas (ajv) — enforced in the CLI test suite (`schema-compliance.test.ts`).
- **Never-modify guarantee:** after every run, `git status` showed only new files under `apps/demo-bank/.flowlet/`.

## 1. Theme fidelity (`theme.json` vs hand-written `mapleBrand`)

Sources scanned: `globals.css` `@theme` block (Tailwind v4 CSS-first; 14 vars). Report printed per-slot provenance.

| Slot | Extracted | Hand-written (`brand.ts`) | Verdict |
|---|---|---|---|
| accent | `#0A7CFF` (DEFAULTED, flagged) | `#1B1C22` graphite | **Miss — unextractable.** demo-bank's CSS defines no accent/primary/brand var; the hand value was chosen from the legacy `mapleTheme` object, which no longer exists in CSS. The CLI defaults and tells the developer to edit. |
| background | `#FBFBFA` (`--color-bg`) | `#F4F3F0` | **Faithful to CSS; hand value disagrees with the app's own CSS.** demo-bank has two divergent brand sources — `globals.css` and `brand.ts` (derived from the old `mapleTheme`). The extractor reflects what the product actually renders. |
| surface | `#FFFFFF` | `#FFFFFF` | Exact. |
| text | `#111111` (`--color-ink`) | `#14151A` | Same divergence as background (CSS vs legacy mapleTheme). |
| mutedText | `#908C85` (`--color-muted`) | `#8A8B92` | Same divergence. |
| fontFamily | `var(--font-inter)` | `var(--font-inter), ui-sans-serif, system-ui, sans-serif` | **Partial.** Extractor carries the raw `--font-sans` value; the hand version appends fallbacks. Neither resolves the `var()` (the schema permits it for fonts, though the sandbox loads no host fonts). Improvement: append a generic fallback stack. |
| radius | `14px` (`--radius-card`) | `16px` | Faithful to CSS; hand value came from `mapleTheme.radius`. |
| mode | `light` | `light` | Exact. |

**Net:** the extractor is faithful to the CSS ground truth; most deltas vs `mapleBrand` are the hand file being stale relative to demo-bank's own stylesheet. Genuine gaps: no accent (needs hand-edit, correctly flagged) and no font fallback synthesis. ENG-201's theme unification will make `theme.json` the single source, which resolves the two-sources problem.

## 2. Tools fidelity (`tools.json` vs hand-written `flowlet/tools.ts` + `policy.ts`)

demo-bank has **no OpenAPI spec**, so the run exercised the route-scan fallback (Decision 3 lists route scan as a tools.json source; the deterministic OpenAPI path is exercised by fixture tests). Result: **23 tools from 21 route files**, all validating against the frozen manifest schema.

- **Coverage the hand demo never had:** accounts, cards, transactions, insights, goals, payees, notifications, orders, profile — the entire HTTP surface, with per-param JSON Schemas the model read out of the handlers. Sample: `list_transactions` documents all 11 query params (search/category/accountId/status/from/to/min/max/sort/limit/cursor) — richer than the hand-written `get_transactions` description.
- **Structural gap (expected):** the two hand-written tools are in-process ai-SDK tools, not HTTP endpoints. `set_rule` has no HTTP equivalent and cannot be extracted from the API surface; `get_transactions` also reshapes data (cents→dollars, Pacific time-of-day) that the raw `list_transactions` endpoint doesn't. In-process tools remain hand-authored (that's ENG-202's client-executor territory, not extraction).
- **Needs hand-editing:** the scan faithfully extracted Flowlet's own plumbing routes (`send_flowlet_chat`, `dispatch_flowlet_action`, `poll_flowlet`, `reset_flowlet`, `list_integrations`, `manage_integration`) — an integrator should delete these. Improvement candidate: skip `app/api/flowlet/**` routes by default.
- **Annotations (pre-fix run, superseded — see addendum):** method-only inference marked all GETs `mutating:false`, which auto-allowed the side-effecting integrations/poll GETs and left `reset_flowlet` non-dangerous. Post-review, all 23 route-scan tools are `mutating:true` and `reset` joined the destructive-name list; the report tells the developer to relax read-only tools by hand. Day-1 UX trade-off (reads gated until reviewed) accepted for safety.

## 3. Component fidelity (`components/` vs the prewired pattern)

demo-bank has **no hand-written host-component wrappers** to diff against (the prewired library wraps OpenUI, not host code), so fidelity = compile + contract conformance + review.

- **Final run: 6/25 candidates wrapped** (`Badge`, `Button`, `HostCard`, `MapleMark`, `SkeletonText`, `Bars`), **19 excluded, 0 failed**. Exclusion reasons are consistently sound: callback-dependent primitives (Switch, Segmented, Dropdown, Tabs, Tooltip, Sheet), hook/animation components (CountUp), providers/portals (Toast, FlowletLayer), and domain-typed cards/charts (AccountCard, CardVisual, Donut, CashflowBars).
- `Card` correctly renamed `HostCard` (collision with the prewired `Card`).
- Generated descriptors match `RegisteredComponent` (`source: "host"`), wrappers safeParse props with the prewired fallback div, `entry.ts` fills the `window.__FLOWLET_HOST__` bundle contract, and the whole tree typechecks inside demo-bank and bundles under `flowletHostPreset`.
- **Nondeterminism is real.** Across four runs the same model wrapped 1–6 components; failure modes were structured-output violations (import statements or file paths in `imports`, empty names on exclusions). Each mode is now handled deterministically (normalize imports → derive from JSX tags restricted to the file's real exports → one repair round-trip with the codegen error), which took the demo-bank run from 1/25-with-16-failures to 6/25-with-0-failures. Residual variance remains and re-runs may differ.
- Quality notes for hand-editing: enum-ish props sometimes come back as `z.string()` with the options in the description instead of `z.enum` (Button `variant`); `MapleMark`'s `className` prop leaks a styling escape hatch the sandbox may not want.

## 4. What needed hand-editing (consolidated)

1. `theme.json`: set `accent` (flagged by the tool); optionally add font fallbacks.
2. `tools.json`: delete 6 Flowlet-internal routes; flip `reset_flowlet` to `dangerous: true`.
3. `components/`: nothing to make it compile; taste-level edits (enum props, `className` exposure) recommended.
4. Not extractable by design: in-process agent tools (`set_rule`) and any data reshaping done inside them.

## 5. Contract notes & open questions (for the orchestrator / follow-up tracks)

The contracts freeze (PR #14) landed mid-session; the CLI now consumes `@flowlet/core` manifest schemas directly and cross-validates against the committed JSON Schemas in its test suite. Remaining open points:

1. **Dark variant:** `manifestThemeSchema`/`BrandTokens` hold a single `mode`. The extractor detects dark-scoped CSS vars and reports them but can only emit one mode. Needs a schema decision when a dark-mode host shows up (demo-bank is light-only).
2. **events[]:** emitted empty. Decision 3 says tools.json declares host event types, but there is no extraction source for them yet (no convention to scan). Presumably hand-authored until a convention exists.
3. **publish assembly:** `flowlet publish` validates `tools.json` and prints the sha256 it would key on (stub, per scope). The full `flowletManifestSchema` (theme + tools + events + components with zod→JSON-Schema props) is the ENG-198 registry's assembly job; the CLI does not fake it.
4. **Naming conventions to bless:** `Host` prefix on registry-name collisions; `<Name>Wrapper` exported symbol; `inputSchema` convention (path/query params top-level, JSON body under `body` — consistent with the binding's fill-by-name path templating).
5. **Scope notes:** route-scan fallback built (grounded in Decision 3; session scope named OpenAPI as primary — flagging per instructions). tRPC extraction skipped ("if cheap" — it wasn't; demo-bank has none). `flowlet dev` (architecture lists it) not in this session's scope. HEAD operations aren't extracted (frozen binding enum has no HEAD).
6. **Operational note:** the Anthropic key in Infisical ran out of credits mid-session (topped up by Yousef); LLM extraction cost per demo-bank run is ~25 analyze calls + 1 route-scan call.
