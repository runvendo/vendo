# Remix execution environment: full option map

Date: 2026-07-04
Status: Research synthesis for decision — precedes rewriting the source-baseline spec
Inputs: 4 research sweeps (in-browser platforms; isolation primitives; cloud architectures; trusted-execution feasibility), sources inline in the findings below. Goal set by Yousef: an end user remixing a component should feel NO difference from the native app — keep all capabilities, be creative, cloud allowed, whatever gets us there.

## The bar

Fidelity: C1 styling (real stylesheet, arbitrary Tailwind), C2 real UI kit, C3 pure npm packages, C4 app helpers, C5 real navigation, C6 live data, C7 governed actions, C8 hooks/state, C9 merged a11y/focus, C10 true layout participation, C11 fast first paint, C12 server components.
Security (non-negotiable): no host-DOM/session access; no egress; actions through the policy chokepoint; no spoofing outside the component box; failure containment.
Operational: OSS zero-infra core; cloud may enhance, never gate; one-command install; licensing clean.

## Options, verdicts first

| # | Option | Verdict |
|---|--------|---------|
| 1 | Host-page execution after static verification | **DEAD END** — proven |
| 2 | Same-realm membranes (SES-only, realms-shim style) | **DEAD END** — incident history |
| 3 | ShadowRealm / new browser primitive | **NOT AVAILABLE** (Stage 2.7, DOM-less) |
| 4 | WebContainers-style in-browser OS | **DISQUALIFIED as core** (license, COOP/COEP on host app, online-only) |
| 5 | SSR-to-inert-HTML in cloud isolate | **Fidelity tier only** (no hooks/handlers — AMP's lesson) |
| 6 | DSL-only (today's prewired trees) | Fidelity ceiling reference — keep as safe floor |
| 7 | **Furnished jail** — vendored env inside the existing iframe | **RECOMMENDED CORE** |
| 8 | **Renderer inversion** — Remote-DOM bridge to host-side real components | **RECOMMENDED CEILING-RAISER** (staged) |
| 9 | Cloud per-variant build service | **RECOMMENDED ENHANCER** (optional tier) |
| 10 | QuickJS-WASM VM for logic | Reserve for headless/automation execution later |

### Why the dead ends are dead (do not relitigate)

- **Verified host-page execution:** Caja abandoned after years of bypasses; vm2's CVE stream (arch-level cause); react-live is `new Function` with no security claim; industry consensus is process/VM/origin isolation, never analysis. Constrained decoding can be adversarially steered (CodeSpear). Static scanning is triage, not containment.
- **Same-realm membranes:** Figma shipped realms-shim, got escaped, rebuilt on QuickJS-WASM ("object representations too different to confuse"); Salesforce Locker → LWS still accretes bypass patterns. Every documented incident is a membrane/validation failure in a shared VM.
- **RSC-as-boundary:** the Flight deserializer just produced CVSS-10 RCE (React2Shell), and RSCs cannot express client interactivity anyway.
- **Shadow DOM:** functional encapsulation only — settled, never a boundary.

## The recommended composite (three tiers + one mandate)

### Tier 1 — Furnish the jail (this epic; OSS, build-time, zero runtime network)

Keep the egress-jailed cross-origin iframe (the browser-endorsed maximal boundary; nothing shipping replaces it). `flowlet sync` builds a **sandbox environment package** into `.flowlet/`:

- **Vendored ESM dependency graph + import map.** Compute the import closure of captured components; classify every import (pure npm / app-local pure / framework-coupled / data / privileged); bundle the first two classes as static ESM (self-hosted esm.sh build pipeline or @jspm/generator offline mode — both proven, MIT-clean). `import { ArrowUpRight } from "lucide-react"` and `import { daysUntil } from "@/lib/format"` resolve for real, offline. Host-controlled allowlist.
- **Host CSS injection + Tailwind JIT.** Inject the app's compiled stylesheet into the stage (mechanism exists: `installFlowletHost {css}`); additionally vendor `@tailwindcss/browser` (v4, MIT, ~300KB, offline) seeded with the host's extracted theme tokens so NOVEL utility classes in edited code compile too. Claude-artifacts-proven pattern, upgraded with the host's own theme.
- **UI-kit auto-registration.** `sync` generates catalog registrations for the app's `components/ui/*` primitives so edited variants can also use real host components through the existing validated host-component path.
- **Framework shims with identical APIs.** `next/link`→dispatch-backed navigation (host router navigates; policy-visible), `next/image`→plain img, `useSWR`/fetch→resolve from anchor data or declared queries via the governed path (the fetcher argument NEVER executes). Shim surface starts with exactly what captured components import; the environment manifest tells the model precisely what is real / shimmed / absent.

Covers: C1–C8 fully, C11 (static vendor bundle, no per-render work). Doesn't touch: C9/C10 seams (iframe a11y/layout), C12.

### Tier 2 — Renderer inversion (follow-up epic; the native-feel ceiling)

Shopify Remote-DOM pattern, generalizing our existing host-components-as-data: untrusted code keeps executing in the jail (iframe or worker) against a virtual DOM; the mutation stream crosses the message channel; the HOST page renders the tree using its real components. Native look because the native side does the rendering: merged a11y tree, real focus order, true layout participation, host CSS with zero duplication (C9, C10 — the seams the iframe can never close). Requirements it inherits: host-side prop validation on every node (exists — ENG-186), event handlers proxied back to the jail, serialize-then-validate on the channel (MetaMask's audit lesson), strict cap on which host components are renderable. This is a rendering-pipeline change; staged deliberately after Tier 1 rather than bundled.

### Tier 3 — Cloud enhancers (optional; never gates OSS)

- **Per-variant build service** for what local vendoring can't express (multi-file variants, deps outside the vendored allowlist): esm.sh-style isolate builds at <100ms–1s and ~$0.01/variant (V8-isolate tier: Dynamic Workers / Deno Subhosting; Firecracker only for full-toolchain jobs). Output lands in the same jailed iframe — cloud prepares, client executes.
- **Publish-time builds** (Plasmic precedent): promoted/shared remixes get a versioned, pre-built bundle on a CDN — faster first paint than in-browser assembly.
- Explicitly rejected: per-end-user-session cloud execution (uncharted, latency/cost-hostile) and SSR-inert as the architecture (display-only tier at most).

### The mandate regardless of tier (from ALL four sweeps)

- **Personal remixes** stay self-served (your pin, your risk, sandbox contains it).
- **Shared/org-wide remixes** require a human approval gate + kill switch + auto-fallback to the original on error/underperformance — Coframe (the only found product shipping AI UI variants to end users) and Figma both converge here. Market note: nobody found executes AI-edited component CODE for end users — this is unoccupied territory, which is both the opportunity and the reason the promotion gate is non-negotiable.
- Policy channel hardening: structured-clone snapshot before validation, never validate live objects.
- Optional SES lockdown inside the sandbox as defense-in-depth (MetaMask pattern).

## Capability score (composite vs today)

| Capability | Today | T1 furnished jail | T1+T2 inversion | +T3 cloud |
|---|---|---|---|---|
| C1 styling | manual restyle | real CSS + JIT | native | native |
| C2 UI kit | reimplemented | vendored real / catalog | host-rendered real | host-rendered real |
| C3 packages | none | vendored allowlist | vendored allowlist | any (built per variant) |
| C4 app helpers | none | vendored | vendored | vendored |
| C5 navigation | dead links | dispatch-shimmed real nav | native links via host render | native |
| C6 data | data.anchor | + useSWR shim | same | same |
| C7 actions | dispatch | dispatch | dispatch | dispatch |
| C8 hooks/state | works | works | works (in-jail exec) | works |
| C9 a11y/focus | iframe seam | iframe seam | **merged/native** | merged |
| C10 layout | box + resize | box + resize | **true participation** | true |
| C11 first paint | iframe boot | same | lighter (host render) | prebuilt bundles |
| C12 RSC | no | no | no | partial (build-time) |

## Decision needed from Yousef

1. Confirm the composite: Tier 1 = this epic (with source capture + `flowlet sync` from the current PR #35 draft); Tier 2 spec'd as its own follow-up epic; Tier 3 designed as optional from day one but built later.
2. Or pull Tier 2 (renderer inversion) INTO this epic — bigger, but it is the only path to "user feels no difference" on a11y/layout/first-paint.
