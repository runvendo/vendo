# Server-Wiring DX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the converged server-wiring DX design (docs/brainstorms/server-wiring-dx.md): a host's server wiring collapses to one registry file plus a ~7-line server file.

**Architecture:** Four waves, each an independently shippable PR. Wave 1 ships the contract-compatible fixes. Wave 2 introduces the unified `auth` key. Wave 3 reshapes the catalog into the single shared registry. Wave 4 updates init, docs, and demos to the new surface. Contract amendments are written before the code that needs them and are gated on Yousef's sign-off.

**Tech Stack:** existing monorepo (pnpm, turbo, vitest, TypeScript); zod v4 native JSON Schema conversion; no new dependencies expected.

**Rules that bind every wave:** `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green before the PR; TDD per task; UI-affecting changes verified in a real browser with screenshots in the PR; never commit to main.

**Execution deviation (recorded 2026-07-18):** per Yousef's "come back to all
the waves finished" instruction, all waves build sequentially on this branch
and ship as ONE PR at the end (wave boundaries marked in the PR body) instead
of per-wave PRs; the Wave 0 sign-off gate moved to PR review. "Wave gate"
checkboxes below mean: affected-package suites + turbo build/typecheck/lint
green at the wave boundary.

---

## Wave 0 — Contract amendments (gate: Yousef sign-off)

The design amends two frozen contracts. Write the amendments first so waves 2–3 build against reviewed text.

- [x] Amend the component-entry contract: a registered component carries ONE
  optional props schema (standard-schema); the model-facing JSON Schema is
  derived internally; `propsJsonSchema` is removed. Catalog accepts the
  name-keyed registry object whose `component` field the server ignores.
  (File: the catalog/component section under docs/contracts/ — locate via
  00-overview.md.)
- [x] Amend the composition contract (09-vendo): `auth` becomes a first-class
  config key accepting a preset that fills the principal, actAs, and door
  oauth seams; the three existing keys remain as the escape hatch; supplying
  both `auth` and any of the three is a validation error.
- [x] Present both amendments to Yousef for sign-off. Do not start wave 2 or 3
  code before approval. Waves 1 may proceed in parallel.
- [x] Commit the amendments once approved.

## Wave 1 — Contract-compatible fixes (one PR)

Four independent tasks; each is test-first and separately committed.

### Task 1.1 — VENDO_BASE_URL fails loud
- Files: packages/vendo/src/server.ts (base-url resolution + the
  present-credentials warning path), packages/vendo/src/wire/doctor.ts,
  matching tests beside them.
- [x] Test: in development with no VENDO_BASE_URL, the learned own-origin is
  treated as trusted (credentials forward) — new behavior.
- [x] Test: in production with no VENDO_BASE_URL, createVendo (or the first
  handled request) fails with an actionable error naming the env var, and
  doctor reports a failing check — replacing the silent audit-only warning.
- [x] Implement; keep the existing cross-origin-binding refusal unchanged
  (same-origin trust only ever applies to the wire's own origin).
- [x] Commit.

### Task 1.2 — Shipped well-known handler
- Files: packages/vendo/src/server.ts (new export), packages/vendo/src/ (its
  test), apps/demo-bank/src/app/.well-known/[...vendo]/route.ts,
  apps/demo-accounting equivalent if present.
- [x] Test: the new exported handler answers exactly the door's four
  discovery paths through vendo.handler and 404s everything else, driven by
  the same path set the door itself owns (no second hardcoded list).
- [x] Implement the export; rewrite the demo route files as two-line
  re-exports.
- [x] Commit.

### Task 1.3 — composio() bare enables everything
- Files: packages/actions/src (composio connector + tests).
- [x] Confirm the Composio API supports unscoped tool listing and what the
  practical catalog size is; record findings in the PR description.
- [x] Test: constructing the connector with no `apps` exposes the full
  catalog through the registry's search path; with `apps` it narrows as
  today; missing api key keeps today's behavior (connector inert/omitted).
- [x] Implement; verify the bounded initial loadout + vendo_tools_search
  keeps the prompt within the existing maxInitialTools cap.
- [x] Commit.

### Task 1.4 — Named policy presets
- Files: packages/guard/src/types.ts + policy.ts (+ tests).
- [x] Test: policy: "cautious" = destructive/write ask + read run;
  "readonly" = read run + write/destructive block; "autopilot" = all run;
  unknown string = validation error. File/rules/code forms unchanged.
- [x] Implement as sugar expanding to rules before evaluation.
- [x] Commit.

- [x] Wave gate: full green quad, PR opened.

## Wave 2 — Unified `auth` key (one PR, needs wave 0 sign-off)

- Files: new packages/vendo/src/auth-presets/ (one module per preset +
  shared shape), packages/vendo/src/server.ts (config validation + seam
  filling), packages/vendo/src/index.ts + package exports,
  apps/demo-bank/src/vendo/* migration, tests throughout.
- [x] Define the preset return shape: { principal, actAs, oauth } — built on
  the existing @vendoai/actions presets rather than duplicating them.
- [x] Test-first authJs(): zero-arg reads AUTH_SECRET (mirroring Auth.js);
  display/email default from session-token claims; optional subject→user
  resolver overrides; secure-cookie posture matches deployment like the
  existing preset.
- [x] Test createVendo({ auth }): all three seams behave identically to
  hand-wiring (present chat, away actAs minting, door session + subject
  resolution); `auth` plus any of principal/actAs/oauth is a validation
  error; the three bare keys alone still work unchanged.
- [x] Test: `auth` (and the underlying `principal`) becomes optional — a
  config with neither boots with anonymous ephemeral sessions only (the
  existing null-principal path becomes the default resolver). `model` stays
  required: the dev-credential ladder is init-scaffold territory
  (lib/ai.ts devModel()), never createVendo semantics — this narrows the
  brainstorm doc's "every key optional" line, per Yousef's model decision.
- [x] Add clerk(), supabase(), auth0(), jwt() presets, each test-first
  against the same three-seam conformance suite (share the suite).
- [x] Migrate demo-bank: delete auth.ts/principal.ts/oauth.ts glue in favor
  of auth: authJs() with its subject resolver; door + away e2e suites stay
  green (fixtures/integration, fixtures/mcp-e2e).
- [x] Update act-as-presets doc to present the auth-key form first.
- [x] Wave gate: full green quad, PR opened.

## Wave 3 — Shared registry catalog (one PR, needs wave 0 sign-off)

- Files: packages/core (component entry type), packages/vendo/src/catalog.ts
  + server.ts, packages/ui (VendoRoot registry prop), packages/apps
  (validation path), apps/demo-bank registry migration, tests throughout.
- [x] Test: catalog accepts the name-keyed registry object; entry name comes
  from the key; `component` field is ignored server-side; array form still
  accepted for back-compat during migration.
- [x] Test: JSON Schema is derived internally from the single zod/standard
  schema (zod v4 native conversion); schema-less entries are legal and
  produce description-only prompt entries with permissive validation;
  derived schema drives both the prompt and generated-props validation (the
  disk-catalog permissive-validation gap closes for schema-bearing entries).
- [x] Implement server side; keep .vendo/catalog.json merging semantics
  (explicit registry wins by name).
- [x] VendoRoot accepts the registry as its components input (entries with
  `component`); update packages/ui tests.
- [x] Migrate demo-bank to one vendo/registry.tsx consumed by both
  server.ts and the root; delete the old catalog block.
- [x] Browser-verify a generated view using a registry component in
  demo-bank; screenshot for the PR.
- [ ] Wave gate: full green quad, PR opened.

## Wave 4 — Docs and demos (one PR)

**Init is OUT OF SCOPE for this lane** — another lane owns `vendo init`. Do
not touch the init scaffolder or its templates. Instead, when waves 2–3
merge, hand the init lane a written summary of the new surface it should
scaffold (server.ts with model + auth + catalog, empty vendo/registry.tsx,
VendoRoot components prop, auth-library detection for the line it writes).

- Files: docs/quickstart.md, door docs, apps/demo-accounting,
  corpus/hosts/express-host.
- [x] Write the init-lane handoff note (the scaffold targets above) and pass
  it via the coordinator / worktree comment. (File:
  docs/superpowers/plans/2026-07-18-init-lane-handoff.md.)
- [x] Rewrite docs/quickstart.md around the new surface (registry +
  auth preset; two files the dev owns). Move MCP-door content off the main
  quickstart path, marked experimental until the live client matrix
  (Claude/ChatGPT/Cursor) is green — record that criterion in the door doc.
  (Door content lives at docs-site/capabilities/mcp.mdx, which already
  carried the full guide; added the graduation-criterion callout and swapped
  its hand-written well-known allowlist for `wellKnownVendoHandler`.)
- [x] Migrate demo-accounting and the Express corpus host to the new
  surface (Express keeps its manual mount; broader Express polish is
  explicitly out of scope per the brainstorm). demo-accounting: one
  vendo/registry.tsx now serves both createVendo's `catalog` and
  `<VendoRoot>`'s `components` (host-components.tsx deleted); auth stays the
  hand-wired trio, NOT `auth: supabase()` — the shipped preset can't verify
  Cadence's ES256 GoTrue sessions (commented in server.ts). Express host
  registers no catalog components and its README made no claims the waves
  falsified — left untouched.
- [ ] Run vendo doctor + one real model turn against migrated demo-bank;
  screenshots of the seeded first turn for the PR.
- [ ] Wave gate: full green quad, PR opened.

## Out of scope (recorded in the brainstorm doc)

Express init polish; migration codemod for external hosts (docs-only
migration notes in wave 4); running the attended MCP live matrix; any client
lane registration ergonomics beyond VendoRoot accepting the registry.

## Sequencing summary

Wave 0 (sign-off gate) → waves 2 and 3 in either order; wave 1 anytime in
parallel; wave 4 last. Each wave's PR merges before the next dependent wave
starts, keeping main releasable throughout.
