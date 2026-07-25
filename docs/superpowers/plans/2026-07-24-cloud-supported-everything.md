# Cloud-Supported Everything Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** With only `VENDO_API_KEY`, every Vendo capability works, content included: config becomes web-editable with draft/test/publish/rollback, secrets get a cloud vault, the playground gets a real backend, and sync becomes one diff-driven AI engine.

**Architecture:** Per the spec (`docs/superpowers/specs/2026-07-23-cloud-supported-everything-design.md`): config resolves explicit > local file > cloud published, with the file's existence as the switch; the console stores one draft + immutable atomic releases per project; format v3 collapses the four tool-knowledge files into generated `tools.json` + authored `overrides.json`; `vendo refine` is deleted.

**Tech Stack:** Existing stacks only. OSS: TypeScript monorepo, zod formats, vitest. Web: Next.js console on OpenNext/Cloudflare, Supabase/Postgres migrations, TipTap for the editor.

**Repos:** OSS = this repo. Web = `~/orca/workspaces/vendo-web`. Per the tandem rule both ship in this wave; contract-first wire fixtures keep merge order independent between repos.

---

## Lane order and dependencies

Lanes 1, 2, and 6 are independent and can start in parallel. Lane 3 needs Lane 2's wire contract (fixtures suffice). Lanes 4 and 5 need Lane 2 deployed. Lane 7 needs Lane 3's CLI surface. Every lane: branch off main, PR, `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green, UI changes browser-verified with screenshots.

### Lane 1 (OSS): Format v3 + sync engine + refine removal

The heavyweight lane; sub-PRs allowed if review size demands.

- [ ] Define v3 formats in the actions block: `tools.json` (vendo/tools@3) gains enrichment fields (description provenance, audience, per-tool field semantics, source hash) plus file-level watermark and domain manifest; `overrides.json` (vendo/overrides@3) absorbs capabilities (compounds, briefs), semantic annotations, and domains additions. TDD against the zod schemas.
- [ ] Registry merge: overrides beat tools by name; retire `capabilities.json` and `semantics.json` readers; orphaned-override detection (entry referencing a missing tool warns loudly).
- [ ] Migration: first v3 sync ingests the legacy four files and writes the two v3 files; covered by fixture tests using real legacy files from the corpus repos.
- [ ] Sync engine: deterministic structural scan unchanged; add the AI pass over diff(watermark to HEAD) with the catalog in context; apply-then-show with `--review` and `--full`; restrictive-only rule enforced in code (AI output that loosens risk/audience/enabled relative to the deterministic baseline is rejected); source-hash tripwire; oversized-diff fallback to full.
- [ ] Model ladder for the AI pass: BYO key, then `VENDO_API_KEY` gateway, then structural-only with entries marked unenriched. Keyless sync must stay green in CI with no model configured.
- [ ] `vendo init` becomes sync-with-no-watermark plus existing scaffolding; the init AI-extract stage and sync enrichment share one engine.
- [ ] Delete `vendo refine`: command, engine, decision log, docs. Miss capture and upload stay.
- [ ] Corpus check: run `pnpm corpus` locally to confirm extraction quality does not regress (local-first per testing doctrine).
- [ ] Amend the archived contracts with a v3 note; update docs and docs-site pages that teach the four files.

### Lane 2 (web): Hosted config service

- [ ] Migration: per-project config draft, immutable releases table, draft/published pointers. A release snapshots all surfaces atomically.
- [ ] Key-authed data-plane route: GET published config with ETag (304 on match). Session-authed console routes: draft read/write, publish (creates release, flips pointer), rollback (repoints), release history.
- [ ] Also store the read-only catalog mirror pushed by keyed sync (Lane 1/3 contract), used later by editor screens.
- [ ] Gating: valid key only, no new meter. Deployment-identity headers meter nothing here but keep the inventory fresh.
- [ ] Wire fixtures committed to both repos so Lane 3 can build against them without this lane deployed.

### Lane 3 (OSS): Config resolution seam + CLI

- [ ] New select seam in the umbrella composition: per surface, explicit config > local `.vendo` file > cloud published config. No block reads env; the key is read at the seam only.
- [ ] Add the missing programmatic overrides (`theme`, `brief`, full overrides content) to `CreateVendoConfig`; cloud fetch injects through the same seams.
- [ ] Live semantics: prompt-family surfaces (design rules, brief, policy directions) re-resolve via short-TTL + ETag provider; a published-version flip invalidates the memoized actions registry so overrides changes apply without restart; structural surfaces stay boot-once (documented).
- [ ] CLI: `vendo push <surface>` (uploads to draft, offers local-file deletion), `vendo pull <surface>` (ejects to file), `vendo config status` (per-surface ownership); doctor reports ownership. Keyed sync pushes the catalog mirror and runs the impact check (removed/disabled tools referenced by user apps, warn with counts).
- [ ] Tests: two-path proof fixture — one host running one surface file-owned and another cloud-owned (against wire fixtures) through the same interface.

### Lane 4 (web): Console Agent editor

- [ ] Per-project Agent section: TipTap editor for prose surfaces (brief, design rules) round-tripping to markdown; schema-validated JSON editors for theme, policy, overrides; overrides screen deep-linked from Gaps.
- [ ] Draft banner, release history with notes, one-click rollback, per-surface effect-class labels (applies instantly / new generations / next load), link to playground for draft testing.
- [ ] Publish dialog shows the diff since the last release and the impact-check result.
- [ ] Browser-verified with screenshots; deferred editor upgrades from the spec stay out.

### Lane 5 (web): Playground backend + load-my-project

- [ ] Deploy a real Vendo host inside vendo-web serving the playground's chat backend (closes the `/api/chat` gap). Public mode keeps the demo catalog.
- [ ] Load-my-project mode: sign-in or pasted key boots the agent against that project's draft config.
- [ ] Browser-verified live on vendo.run/playground with screenshots.

### Lane 6 (both repos): Secrets + seam cleanups

- [ ] Web: per-project encrypted secrets (application-layer encryption per the `hosted_instances` pattern), write-only console UI (names and dates visible, values never displayed), key-authed runtime read endpoint.
- [ ] OSS: `cloudSecrets` behind the existing `SecretsProvider` seam; resolution explicit > env > cloud with env winning. Grants, box injection, redaction untouched.
- [ ] OSS: hoist the miss-capture `VENDO_API_KEY` read into a select seam in the umbrella; remove the env fallback from the shared cloud fetch helper.
- [ ] Live verification: one API-key-auth Composio toolkit end-to-end through the connect dock (spec requirement).

### Lane 7: Wave close-out

- [ ] Done-means proofs from the spec, recorded in the PR(s): console edit reaches a running deployment via publish + TTL without restart (execution-time surface) and on next generation (generation-time surface); rollback restores the prior release; playground runs a draft end to end; keyless init and sync green with no model.
- [ ] Docs sync both repos: ownership model, effect classes, secrets-vs-connections, v3 file formats, push/pull workflow. docs-site quickstarts updated where they teach retired files.
- [ ] Update Linear and memory; remove worker worktrees on merge (memory-blowup rule).

---

## Self-review notes

Spec coverage checked section-by-section: ownership model (L3), format v3 (L1), sync engine and refine removal (L1), config service and atomic releases (L2), editor v1 scope (L4), playground (L5), effect classes (L4 labels + L7 proofs), impact check (L3 CLI + L4 dialog), secrets (L6), miss-capture fix (L6), out-of-scope list respected (no lane builds deferred items). No placeholders; lane boundaries match the spec's delivery section with Lane 6 merging the two cleanup items into one cross-repo lane.
