# Remix Fidelity Epic Implementation Plan (source baseline + furnished environment)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docs/superpowers/specs/2026-07-04-remix-source-baseline-design.md`: the agent edits captured REAL component source, and that edited code runs in a sandbox furnished with the app's real stylesheet, Tailwind JIT, UI kit, pure packages, local helpers, and framework shims — snapshot + bare sandbox remaining the fallback at every layer.

**Architecture:** Contracts → engine prompt (manifest-driven) → server enrichment → `flowlet sync` (capture + classification + vendoring + CSS + manifest + catalog registrations) → shims package → stage env loading → Cadence wiring → fidelity verification. Stacks on PR #34. Renderer inversion and cloud builds are explicitly out (see option map).

**Tech stack:** TypeScript, vitest, zod. Parser for the CLI: TypeScript's own compiler API (available transitively, no new install; add ts-morph only if bare API proves too painful). Bundler for vendoring: esbuild (already in the repo toolchain). New package `@flowlet/sandbox-shims`.

**Process rules:** TDD per task on branch `yousefh409/remix-source-baseline`; full suite in Task 9; stop and surface on any locked-architecture conflict. NOTE: several tasks touch the stage/sandbox — every stage change must keep the "no env present → byte-identical behavior" test green.

---

### Task 1: Contracts

**Files:**
- Modify: `packages/flowlet-core/src/protocol.ts` (+ test): scoped block gains `source?: string` (NOT AnchorRef); export `RemixSourceRecord`, `RemixSourceResolver`, and `EnvManifest` types (per-import classification: `real | shimmed | absent`, per-anchor).

- [ ] Failing tests for all three shapes; implement additively; green; commit.

### Task 2: Engine — source block + manifest-driven environment section

**Files:**
- Modify: `packages/flowlet-runtime/src/engine.ts` (+ `engine.test.ts`)

- [ ] Failing tests: scoped anchor with `source` → delimited untrusted-data block, captured-snapshot framing, edited-variant instruction, non-disclosure nudge; adversarial source-comment test; WITH an env manifest → the prompt lists real/shimmed/absent imports with prescribed alternatives; WITHOUT env → today's blanket guidance; WITHOUT source → byte-identical to today.
- [ ] Implement (engine receives the manifest via config, same seam style as `components`); 48 KB source cap as last defense; green; commit.

### Task 3: @flowlet/next — load + enrich (unchanged from reviewed v1 scope)

**Files:**
- Modify: `packages/flowlet-next/src/flowlet-dir.ts`, `options.ts`, `chat.ts`, `handler.ts` (+ tests)

- [ ] Failing tests: `remix-sources.json` absent → empty / present-invalid → fail loud (zod); `env/manifest.json` loaded the same way; client-supplied `scoped.source` stripped always; enrichment by anchorId; option resolver precedence with `undefined` fall-through; dev-mode re-read of the mapped file (`NODE_ENV !== "production"`), production never touches the filesystem at request time; manifest handed to the agent config.
- [ ] Implement; green; commit.

### Task 4: CLI — `flowlet sync` capture core

**Files:**
- Create: `packages/flowlet-cli/src/sync/capture.ts` (+ test) — the v1 source-capture scan.
- Modify: `packages/flowlet-cli/src/cli.ts` (+ `cli.test.ts`): new `flowlet sync [dir]` command + help.
- Modify: `packages/flowlet-cli/src/init.ts` / `next-wiring.ts` (+ tests): wire `flowlet sync` into `prebuild` (create/extend idempotently); init runs it once, empty-is-fine report line.
- Modify: `packages/flowlet-cli/package.json` if a parser dep is added.

- [ ] Failing fixtures: literal-id capture with resolved child file + `sourceHash` + `capturedAt`; dynamic id skipped + reported; multi-child → enclosing file; unresolvable import omitted + reported; `@/*` aliases, extensionless imports, `index` barrels, relative paths (Cadence's `@/components/dashboard/deadline-list` is the reference); server-only refusals AFTER alias resolution; 48 KB cap.
- [ ] Implement deterministically (AST, no LLM), fail-open per anchor; green; commit.

### Task 5: CLI — classification + vendoring + CSS + manifest + catalog registrations

**Files:**
- Create: `packages/flowlet-cli/src/sync/classify.ts`, `sync/vendor.ts`, `sync/host-css.ts`, `sync/catalog-gen.ts` (+ tests each)

- [ ] Classify failing fixtures: pure npm / app-local pure / framework-coupled / data / refused-unknown, driven by import specifier + resolved location + refusal rules; allowlist starts at "what captured components import", extendable via config.
- [ ] Vendor failing fixtures: esbuild ESM output per allowlisted entry, react/react-dom externalized to the stage shim, deterministic output paths, import-map generation; total-size soft cap (2 MB) warns listing heaviest entries.
- [ ] Host CSS: locate the app's built stylesheet (Next `.next/static/css` after build; fail-open with report when absent), rewrite/drop URL assets to same-origin, copy theme tokens; vendor `@tailwindcss/browser` seeded with extracted tokens.
- [ ] Catalog generation: `components/ui/*` registrations with TS-type-derived prop schemas where derivable, report-skipped otherwise.
- [ ] Manifest: per-anchor, per-import `real | shimmed | absent` + sizes + report. Artifacts copied into `public/flowlet/env/`.
- [ ] All green; commit per sub-module as they land.

### Task 6: `@flowlet/sandbox-shims` (new package)

**Files:**
- Create: `packages/flowlet-sandbox-shims/` (package scaffold matching sibling packages) with `next-link.tsx`, `next-image.tsx`, `next-navigation.ts`, `swr.ts` (+ tests each)

- [ ] Failing tests: link renders an anchor and dispatches `navigate` through the bridge on click (no real navigation from inside); image renders `img` with the prop surface mapped; `useSWR` resolves from anchor data / declared queries, NEVER invokes the fetcher, mutate no-ops without a declared query; unsupported APIs throw descriptive contained errors.
- [ ] Implement; wire into the vendor import map under the framework specifiers; green; commit.

### Task 7: Stage env loading

**Files:**
- Modify: `packages/flowlet-stage/src/stage-host.ts` / `genui-host.ts` and `packages/flowlet-components/src/sandbox-install.ts` (+ tests); `packages/flowlet-next/src/client/sandbox-stage.tsx` (+ test) to pass env URLs.

- [ ] Failing tests: env present → import map extended with vendor + shim entries, `host.css` injected first, Tailwind JIT loaded with tokens; env absent → BYTE-IDENTICAL current behavior (snapshot the generated sandbox doc in both modes); a missing vendored module at runtime surfaces as a contained sandbox error (existing fail-open path).
- [ ] Implement; green; commit. UI checkpoint: showcase screenshot of an edited component rendering with real CSS + icons.

### Task 8: Cadence wiring

**Files:**
- Modify: Cadence chat handler for source enrichment (raw `readFileSync` of `deadline-list.tsx`, shared cap helper — never a module import); run `flowlet sync`-equivalent artifacts for the demo (checked-in `env/` for the deadlines widget's closure: lucide-react, `@/lib/format`, `@/components/ui/*`, swr shim).

- [ ] Failing test: scoped send reaches the agent with source + manifest; missing file falls open.
- [ ] Implement; green; commit.

### Task 9: Full suite green

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` (demo-bank lint remains pre-existing-broken); fix regressions; commit.

### Task 10: Real-browser fidelity verification

- [ ] `pnpm demo:accounting`; run the SAME remix ask as PR #34's verification against the deadlines widget with the full environment; verify: real Tailwind classes render, lucide icons appear, `@/lib/format` output matches, row links navigate via dispatch, live data updates. Screenshot set side-by-side with PR #34's bare-sandbox results.
- [ ] Verify fallback: delete `env/` → today's behavior, no errors.

### Task 11: Codex diff review + PR update

- [ ] Codex review of the full diff; triage with code verification; fix; rerun affected tests.
- [ ] Push; update PR #35 (title/body: docs → implementation) with the comparison screenshots. Do not merge.
