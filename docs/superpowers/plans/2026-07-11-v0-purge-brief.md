# Wave 1: v0 Purge Brief

Companion to docs/superpowers/specs/2026-07-11-oss-v0-campaign-design.md. This wave deletes everything from the old version that becomes dead under the v0 target. It does not restructure, rename, or port anything.

## Definition of dead

Something is dead if at least one holds:

1. Unreferenced today: no runtime, test, build, or doc path reaches it (dead exports, orphaned files, stale scripts, leftover reports)
2. Describes the old version: docs, specs, plans, and examples whose subject is the pre-v0 architecture or APIs that the campaign replaces wholesale (git history preserves them)
3. Obsoleted by the page: features or artifacts the v0 design explicitly dropped or replaced, with no port destination in any later wave

## Explicit keeps (porting reference for later waves, do not touch)

- All live package source that later waves port: extraction engine, guard and permissions, automations scheduler and persistence, store, agent loop, UI components and shell and stage, CLI, telemetry
- apps/demo-bank (Maple) and apps/demo-accounting (Cadence): acceptance bar
- corpus/ (12-repo extraction and live e2e suite): acceptance bar
- vendor/ (fluidkit tarball dependency)
- LICENSE, NOTICE, SECURITY.md, TELEMETRY.md, CODE_OF_CONDUCT.md, CONTRIBUTING.md
- Root build config (turbo.json, tsconfig.base.json, pnpm-workspace.yaml) except entries that reference deleted things

## Bar for this wave

- Repo stays green after the purge: pnpm build, test, typecheck, lint all pass (measured against the recorded pre-purge baseline)
- Every deletion is logged in the purge log with a one-line rationale and category (1, 2, or 3)
- Deletions land as reviewable commits grouped by area
- Anything debatable is flagged in the log, not silently deleted

## Out of scope for this wave

- Renaming anything
- Moving code between packages
- Rewriting docs to describe v0
- Touching the Notion page
