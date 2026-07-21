# App design rules (config key + live reads) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hosts can set app-generation design rules programmatically
(`apps.designRules` on `CreateVendoConfig`), and `.vendo/design-rules.md`
edits apply to the next generation without a server restart.

**Architecture:** Widen the existing `designRules` seam (umbrella →
`createApps` → engine prompt section) to accept a provider function
alongside the current string, resolved when prompt sections are built. The
umbrella passes the config string when set, else a lazy per-call file read.
No new prompt sections, no contract changes; the widening is additive.

**Spec:** `docs/superpowers/specs/2026-07-20-app-design-instructions-design.md`

---

### Task 1: Engine accepts a designRules provider

Files: `packages/apps/src/engine.ts`, `packages/apps/src/engine.test.ts`

- [ ] Failing test: a provider-function `designRules` whose value changes
      between two generations produces different `design-rules` section
      content per generation; string form unchanged.
- [ ] Widen the `designRules` dependency type and resolve it where prompt
      sections are built (both create and edit paths).
- [ ] Tests pass; commit.

### Task 2: Runtime threads the widened type

Files: `packages/apps/src/runtime.ts` (config type + passthrough)

- [ ] Widen the `AppsConfig.designRules` type to match; passthrough is
      already direct. Typecheck the package; commit (fold into Task 1's
      commit if trivial).

### Task 3: Umbrella config key + lazy file read

Files: `packages/vendo/src/server.ts`, the vendo package's server tests

- [ ] Failing tests: (a) `apps.designRules` config wins over the file;
      (b) whitespace-only config falls through to the file; (c) a
      `design-rules.md` write after `createVendo` is seen by the next
      generation; (d) unset behaves as today.
- [ ] Add `apps.designRules` to `CreateVendoConfig` (doc comment per house
      style); replace the compose-time read with the resolver passed to
      `createApps`.
- [ ] Tests pass; commit.

### Task 4: Docs sync

Files: `docs-site/reference/dot-vendo.mdx`,
`docs-site/connect/instructions.mdx`, `docs-site/connect/theming.mdx`,
`docs-site/concepts/prompts.mdx`, plus `docs/` mirror counterparts.

- [ ] Note the config key, precedence, and live file reads where
      `design-rules.md` is documented; keep edits minimal and in each
      page's voice; commit.

### Task 5: Gates + PR

- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green.
- [ ] Open PR against `main` (no UI-affecting change → no screenshots
      needed; prompt plumbing only).
