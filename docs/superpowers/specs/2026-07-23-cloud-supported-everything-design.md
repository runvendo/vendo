# Cloud-supported everything: hosted config, sync v3, secrets, playground

Status: approved direction, decided with Yousef 2026-07-23.
Builds on `2026-07-17-vendo-cloud-definition-design.md` (adapter rule, key + meter
gating, hard BYO). Both repos (`runvendo/vendo`, `runvendo/vendo-web`) ship in
the same wave.

## Goal

A customer brings one `VENDO_API_KEY` and everything works: infrastructure and
content. The cloud path is better, not just present: agent config becomes
web-editable, release-managed (draft, test, publish, rollback), and editable by
non-engineers. The keyless path stays complete forever: files only, no cloud,
no degradation of single-player capability.

## Audit findings this design answers

- Nine seams already have cloud adapters (inference, box inference, sandbox,
  hosted store, connections, tools broker, apps share/publish, miss upload,
  hosted automations firing). Infra coverage is done.
- Every content surface (`design-rules.md`, `brief.md`, `theme.json`,
  `policy.json`, the tool-knowledge files) is local-disk only. The console
  stores no customer config anywhere.
- `theme.json`, `brief.md`, and `overrides.json` have no programmatic override:
  the file is the only source.
- The playground at vendo.run/playground has no backend: it posts to routes no
  service serves.
- Miss capture reads `VENDO_API_KEY` inside the module, violating the adapter
  rule.
- A keyed customer on hosted store has no home for action secrets.

## Ownership model

Per surface, resolution follows the locked adapter rule: explicit config field,
then local `.vendo` file, then cloud published config. The file's existence is
the switch. One source of truth per surface; no bidirectional sync, no drift.

- `vendo push <surface>` uploads to the cloud draft and offers to delete the
  local file. `vendo pull <surface>` ejects cloud config back to a file.
  `vendo config status` shows per-surface ownership; doctor reports the same.
- Cloud-editable surfaces: `overrides.json`, `design-rules.md`, `brief.md`,
  `theme.json`, `policy.json`.
- Code-owned by default: `tools.json` (generated artifact; pushable only as a
  read-only mirror, never cloud-edited).
- `theme` and `brief` gain config-object overrides in `CreateVendoConfig`; the
  cloud fetch injects through the same seams a host can use programmatically.

## Format v3: two files instead of four

Split by author, not by pipeline stage. `capabilities.json` and
`semantics.json` retire.

**`tools.json` (vendo/tools@3), machine layer.** Generated, sync-owned
wholesale, never hand-edited, regenerable at any time. Per tool: descriptor,
execution binding (unchanged five kinds), enriched description, risk, audience,
field semantics inferred from code, and a source hash. File level: the sync
watermark (git tree of the last sync) and the derived domain manifest.

**`overrides.json` (vendo/overrides@3), authored layer.** The one
human-written surface and the one cloud-editable tool surface. Per-tool
corrections (risk, critical, disabled, audience, description, field-semantic
annotations), domain manifest additions, compound tools, capability briefs,
remix ignoreSlots. Merges over `tools.json` by tool name and always wins.

Safety rule: sync's AI may only make a tool more restrictive than the
deterministic baseline (raise risk, narrow audience, disable). Loosening
happens only in `overrides.json`, i.e. by a human.

Migration: the first v3 sync ingests the legacy four files and writes the two
v3 files. Orphaned override entries (referencing tools that no longer exist)
are flagged loudly. The archived contracts get an amendment note.

## Sync engine: init = sync, diff-driven AI

- The structural scan stays deterministic: route discovery, bindings, schemas.
  This part executes and never hallucinates.
- The AI pass reads `diff(watermark -> HEAD)` with the current catalog in
  context and updates affected entries: writes real descriptions, classifies
  routes the scanner cannot, infers semantics from handler code and types,
  judges risk and audience, and catches indirect effects (a shared helper
  change that alters the meaning of tools whose files never changed). It emits
  a change narrative.
- Apply-then-show: sync writes the file and prints the narrative; the git diff
  is the review. `--review` confirms before writing; `--full` re-enriches
  everything. Oversized diffs fall back to full re-enrichment.
- Tripwire: a changed source hash the AI pass did not account for triggers a
  targeted re-read.
- Model ladder: BYO model key, then `VENDO_API_KEY` managed inference, then no
  model at all, which degrades to structural-only sync with entries marked
  unenriched. Keyless never breaks.
- `vendo init` is sync with no watermark (full-repo enrichment) plus one-time
  scaffolding: theme extraction, brief, policy, route wiring.
- When keyed, sync also pushes a read-only catalog mirror to the project (so
  the console can render editors against real tools) and runs the impact
  check.
- **`vendo refine` is removed**: the command, engine, and decision log are
  deleted. Miss capture and the console Gaps dashboard stay; the improvement
  loop is human (see gap, edit config, test, publish).

## Hosted config service (console)

- One config document per project; document keys mirror the surface names.
- `config_versions` immutable snapshots plus two pointers: draft and
  published. Publish flips the pointer; rollback points published at a prior
  version.
- Runtime read: key-authed `GET /api/v1/config` returning the published
  version with an ETag. OSS fetches at compose and re-fetches on a short TTL;
  a version flip invalidates the memoized actions registry so overrides
  changes apply without restart.
- Editing: session-authed draft get/put, publish, rollback, version history.
- Gating: valid key only. No new meter.

## Console editor

A per-project Agent section: markdown editors for design rules and brief,
schema-validated editors for theme and policy, and an overrides editor
(risk labels, enablement, descriptions, semantics corrections, domains,
compounds, briefs) rendered against the catalog mirror and linked from the
Gaps dashboard. Draft banner, version history with notes, one-click rollback.
Each surface is labeled with its effect class.

## Playground

Becomes a real Vendo host deployed in vendo-web, serving its own chat backend
(closing the current no-backend gap; the playground is also the dogfood).
Public mode keeps the demo catalog. Signed-in or key-pasted mode boots the
agent against the project's draft config: the test half of draft, test,
publish.

## Effect classes: how published changes hit end users' apps

- Execution-time (policy, risk, disabled, connections): applies instantly to
  every existing app; tightening protects immediately.
- Generation-time (design rules, brief, semantics, compounds, briefs): applies
  to new generations and edits only; existing apps never mutate.
- Presentation-time (theme): applies live on next load.

Documented in the docs and labeled per surface in the editor.

## Impact check (v1-lite)

On console publish and on keyed sync: diff the tool set, scan the project's
app inventory for references to removed or disabled tools, and warn with app
and deployment counts. Full semantic impact analysis is out of scope.

## Hosted secrets

`cloudSecrets` implements the existing `SecretsProvider` seam. Resolution:
explicit provider, then env, then cloud (env wins so local overrides always
work). Console side: per-project encrypted secrets (same encryption pattern as
`hosted_instances`), names visible, values write-only in the UI, key-authed
runtime read. Closes the hole where a hosted-store customer has nowhere to put
action secrets.

## Cleanups riding the wave

- Miss-capture key read hoisted out of `capability-misses.ts` into a select
  seam in `server.ts`; `cloudKeyFetch` loses its env fallback.
- Doctor learns per-surface ownership reporting.

## Out of scope (deliberate)

Hosted theme extraction (ENG-354), knowledge/memory blocks (do not exist yet),
eval-gated publishing (the publish pointer is its future hook), any refine
successor, deployment-side ownership reporting in the console, full semantic
impact analysis, and any per-plan gating (key + meter only, per the locked
cloud definition).

## Delivery

One wave, both repos in tandem.

- OSS: (1) format v3, sync engine, refine removal; (2) config resolution seam
  plus theme/brief programmatic overrides and TTL fetch with registry reload;
  (3) cloudSecrets and the miss-capture seam fix; (4) CLI push/pull/status,
  doctor, docs.
- vendo-web: (1) config service, versions, publish pipeline; (2) console Agent
  editor linked from Gaps; (3) playground backend and load-my-project.
- UI changes are browser-verified with screenshots in the PR, per repo rules.

## Done means

Both repos green (build, test, typecheck, lint). A two-path proof: the same
host running one surface file-owned and another cloud-owned through the same
interface. Keyless init and sync work with no model configured. A console edit
reaches a running deployment through publish and TTL pickup without restart
(for an execution-time surface) and on next generation (for a generation-time
surface). Rollback restores the prior published version. The playground runs a
draft config end to end.
