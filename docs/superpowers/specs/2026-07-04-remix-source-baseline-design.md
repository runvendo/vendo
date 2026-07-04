# Remix fidelity epic: source baseline + furnished sandbox environment

Date: 2026-07-04
Status: Approved design (Yousef: option A + "Fix 1"; see `2026-07-04-remix-environment-options.md` for the full researched option map), pre-plan
Owner: Yousef (approval delegated for spec + plan; build not started)

## Why

Two compounding upgrades so a remixed component stops feeling like an approximation:

1. **Source baseline.** The agent edits the dev's REAL component source (captured at build time) instead of reverse-engineering a DOM snapshot — structure, conditional logic, and data handling carry over; only the requested delta changes.
2. **Furnished sandbox environment.** The egress-jailed iframe stays (the researched, browser-endorsed boundary — see option map, options 1–5 for the rejected alternatives), but `flowlet sync` furnishes it with the app's real ingredients: stylesheet, Tailwind JIT with the host theme, UI kit, pure npm packages, local helpers, and identical-API shims for the framework layer. The edited source then largely RUNS as written.

Renderer inversion (option map Tier 2 — host-side rendering of the emitted tree, closing the a11y/layout/first-paint seams) is the designated follow-up epic, deliberately not in scope. Cloud per-variant builds (Tier 3) are designed-for but not built.

## Constraints that do not move

- The host component's source file is never modified. Output runs in the egress-jailed sandbox, pins per user, resets instantly, fails open to the original children.
- Zero runtime network from the sandbox: everything the environment provides is vendored at build time and served from the host's own origin (`public/flowlet/`), same as today's stage assets. The CSP jail is untouched.
- OSS zero-infra path keeps working with no sync run at all — snapshot baseline + today's bare environment remain the fallback at every layer.

## Threat model

Unchanged from the reviewed v1 of this spec, plus one addition:

- Captured sources are frontend component files — public-class code that already ships compiled to every browser. Only client-bundle code is capturable (extractor refuses `"use server"`, `server/`, `api/`, `pages/api/`, and anything outside the app source root). The captured map stays server-side; a tampered client can request enrichment only for captured anchors of the app it is already served. Injected source is wrapped as delimited untrusted data (comments/strings are never instructions), with a non-disclosure nudge as UX polish, not a security control.
- **New — vendored environment:** the vendor bundle contains the HOST'S OWN dependencies and helpers, chosen by a host-controlled allowlist at build time. It is host-trusted code running inside the jail alongside untrusted generated code — the same trust class as today's catalog bundle. The classification step must never vendor server-only modules (same refusal rules as source capture); URL-bearing assets inside vendored CSS are rewritten to same-origin or dropped.

## `flowlet sync` — one command, per build

Replaces v1's `flowlet remix-sources`. Lifecycle unchanged from the reviewed revision: capture is a per-build concern; `flowlet init` only WIRES it (adds `flowlet sync` to `prebuild`, runs it once, expects empty on fresh installs) — because at init time the app has zero wrappers. Dev mode re-reads mapped source files at request time so an edited component is never a stale baseline; the AST scanner stays in the CLI.

`sync` produces, into `.flowlet/`:

1. **`remix-sources.json`** — as reviewed in v1: `{ [anchorId]: RemixSourceRecord }` (`file`, `exportName?`, `source`, `sourceHash`, `capturedAt`), literal-id AST scan, alias-aware import resolution, server-only refusal, 48 KB cap, fail-open per anchor with report entries.
2. **`env/vendor/`** + **`env/import-map.json`** — the vendored ESM dependency graph. Compute the import closure of captured components; classify every import:
   - **pure npm** (lucide-react, date-fns, clsx, …) → bundle as static ESM (esbuild, which the repo toolchain already carries), entry per package, externalized react/react-dom (the stage's shared shim supplies them);
   - **app-local pure modules** (`@/lib/format`, …) → same treatment, subject to the server-only refusal rules;
   - **framework-coupled** (`next/link`, `next/image`, `next/navigation`) → mapped to the shim package (below), not bundled from the app;
   - **data** (`swr`, raw fetch) → mapped to shims; the fetcher path never executes;
   - **unknown/refused** → listed in the manifest as absent.
   The allowlist starts as "exactly what captured components import" and is host-extendable in `flowlet.config`; nothing outside it is ever vendored.
3. **`env/host.css`** — compiled DURING sync, from source (Tailwind v4 CLI over the app's stylesheet entry when Tailwind is detected; otherwise a configured `cssPath`), NOT read from `.next/static/css` — `prebuild` runs before `next build`, so build output would be stale-or-absent by construction. URL policy (the sandbox CSP allows only `data:` for images/fonts and stays untouched): every fetchable `url()`/`@import`/`@font-face` reference is either inlined as a `data:` URI at build time (under a per-asset size cap) or dropped with a report entry — the sanitized output contains ZERO fetchable URLs, verified by test.
4. **`env/manifest.json`** — per-import classification (real / shimmed / absent) per anchor, sizes, and the capture report. This is both the dev's fidelity report and the model's environment contract.
5. **UI-kit catalog registrations** — generated `hostComponent` registrations for the app's `components/ui/*` primitives (props inferred from TypeScript types where possible; skipped with a report entry where not), so edited variants can also compose real host components through the existing validated path.

`sync` copies the runtime-needed artifacts into `public/flowlet/env/` the same way init places stage assets today.

## Shims (`@flowlet/sandbox-shims`, new package)

Identical-API stand-ins vendored into the environment:

- `next/link` → renders an anchor; clicks emit the RESERVED `flowlet.navigate` action. Navigation is handled CLIENT-SIDE by the host receiver (`SandboxStage`), never sent to the server `/action` route (it is local UI, not a tool call — documented decision): the receiver validates the href (same-app path-only; `javascript:`, protocol-relative, and external URLs rejected) and then drives the host router. Same for a minimal `next/navigation` subset (`useRouter().push` → same reserved action).
- `next/image` → plain `img` with the same prop surface (fill/sizes approximated), src subject to the sandbox CSP as ever.
- `swr` → `useSWR(key, fetcher)` returns data resolved from the anchor's live `data.anchor` payload or declared governed queries; the fetcher argument is NEVER invoked; mutate/revalidate map to the query-refresh path where declared, no-op otherwise.
- Everything a shim cannot honestly express throws a descriptive error inside the sandbox (contained by the existing fail-open boundary) rather than silently misbehaving.

Shims are versioned with the package and listed in the manifest so the model knows exactly which APIs are real, shimmed, or absent.

## Stage changes (@flowlet/stage + @flowlet/next)

- **Blob pipeline, CSP untouched.** The iframe CSP allows only nonce scripts and `blob:` (`connect-src 'none'`), and today's import map is React-to-blob only. Static `/flowlet/env/...` URLs would be BLOCKED inside the iframe — correctly. So the HOST side (`SandboxStage`) fetches all env artifacts (vendor ESM, shims, host.css, Tailwind runtime) on its own origin, converts them to blob URLs, and injects a complete blob-backed import map + style content into the stage before runtime execution. Zero network from inside the iframe is preserved by construction, and the CSP does not change.
- **Explicit env plumbing, not `installFlowletHost` overload.** The existing `installFlowletHost({ css })` option is only a primitive (inline `<style>` at bundle eval). This epic adds a first-class stage env API (`createStage`/`FlowletStage` accepts the fetched env: import-map entries, styles in order — host.css first, Tailwind JIT for what it doesn't cover — and the token seed), with mount-time-only application.
- **Fatal-error channel (closes a declared PR #34 follow-up).** The stage runtime reports fatal load/module errors (missing vendored module, failed import) to the host via the bridge; `SandboxStage` exposes it; `FlowletRemix` marks the pin broken and falls open to the original children. Until that message arrives, the stage's contained error rendering remains the inner fallback.
- All of this is capability-additive: no `env/` present → the stage behaves byte-for-byte as today (tested by snapshotting the generated sandbox document in both modes).

## Engine prompt

The reviewed v1 source-baseline section stands (captured-snapshot framing, delimited untrusted-data block, adversarial test, non-disclosure nudge), plus one contract instruction: the stage loader consumes `mod.default`, so the emitted module MUST default-export the component — when the captured source used a named export (`exportName` in the record, e.g. `DeadlineList`), the prompt says so explicitly and instructs the conversion. The mapping rules are REPLACED by manifest-driven precision: the anchor section lists, from `env/manifest.json`, which imports resolve for real, which are shimmed (with the shim's honest semantics), and which are absent (with the prescribed alternative — `data.anchor` bindings, catalog components, inline styles). The old blanket "imports don't exist, restyle everything" guidance applies only when no environment is present.

## Server injection (@flowlet/next) — unchanged from reviewed v1

`loadFlowletDir` reads `remix-sources.json` (absent → empty; present-invalid → fail loud, zod). `handleChat` strips client-supplied `scoped.source` and enriches server-side; option `remixSources` (map or resolver) wins over the file, `undefined` falls through. Dev mode re-reads the mapped file. Cadence wires its map with a raw server-side file read.

## Failure handling

- Every layer degrades independently: no sources → snapshot baseline; no env → bare sandbox + blanket guidance; a missing vendored module at runtime → stage fatal-error channel → pin marked broken → original children (the new channel above; NOT assumed from the existing boundary, which only catches host-side render throws).
- `sync` is fail-open per item with a complete report; it never fails the host build for a classification gap (it CAN fail loud for its own bugs — malformed output).
- Oversized vendor budget: total env size is reported; beyond a soft cap (2 MB) `sync` warns and lists the heaviest entries; nothing is silently dropped.

## Sharing mandate (forward requirement, from the research)

Pins are per-user today. WHEN sharing/promotion of remixes ships (separate epic), it MUST carry: human approval before a remix reaches other users, a kill switch, and auto-fallback to the original on error. Recorded here so no future epic ships sharing without it.

## Testing

- CLI: v1's capture fixtures (literal ids, aliases, refusals, caps) + classification fixtures (pure npm vs app-local vs framework vs data vs refused), vendor output shape, manifest correctness, `flowlet sync` command + prebuild wiring, init-runs-once-empty.
- Shims: unit tests per shim (link dispatches navigate; useSWR resolves anchor data and never calls the fetcher; image renders).
- Stage: env present → import map extended + CSS injected + JIT active; env absent → byte-identical behavior.
- Engine: manifest-driven prompt section; no-env fallback prompt; adversarial source-comment test (v1).
- Real-browser fidelity verification in Cadence: same remix ask on the deadlines widget with full environment vs PR #34's bare-sandbox screenshots, side by side in the PR.

## Decided against / deferred

- Renderer inversion (Tier 2) — designated next epic; option map has the design sketch and security analysis.
- Cloud per-variant builds and publish-time bundles (Tier 3) — the manifest/vendor format is the interface they'd plug into; not built.
- WebContainers, SSR-inert, host-page execution, same-realm membranes — rejected with reasons in the option map.
- Promote-to-code — deferred to publish epic (ENG-198).
- Inlining transitive local dependency closures beyond what classification reaches — revisit with real-host evidence.

## Dependencies

- PR #34 (FlowletRemix + FlowletToasts) — stacked on it.
- Option map: `2026-07-04-remix-environment-options.md` (companion document, same PR).
- ENG-197 extractor conventions; existing stage import-map/`installFlowletHost` mechanisms.
