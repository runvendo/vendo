# Assumption audit + kill-list — 2026-07-11

Session record. Produced by a 5-scout audit of the repo against the settled product direction on the
"Open-Source Full Stack Agentic Interface" Notion page (2026-07-11 state). Drives the cleanup pass on
`yousefh409/features-review`. The repo baseline was fully green (build/typecheck/lint/test) before cleanup.

## Settled direction (what the code is being reconciled to)

- The artifact is an **app**: manifest + optional fields (UI, state, server code, own data, own files, trigger).
  The old saved-artifact layer (saved "vendos", remix pins, library UI) predates this and is **deleted, not migrated**;
  save/library/remix/automation-create features are stubbed off pending the Phase 1 rebuild on the app-format spec.
- Layering: core → apps → automations; every other block depends only on core. (Not yet reflected in package
  structure — that is Phase 1 work, recorded here, not done in this pass.)
- An app executes as its user, never its author.
- Killed at product level: agent-watched trigger kind, knowledge/RAG ingestion pipelines, the agent loop as a
  standalone product, "every block exposed over MCP", shape approvals (deferred to Future).

## Audit headlines

1. **Three of four killed features left zero code** (agent-watched triggers¹, RAG ingestion, outward MCP were never
   built in packages/). ¹Exception: demo-bank implements an agent-watched trigger wholesale via its transaction
   poller — deleted in this pass.
2. **Naming is already clean**: no "flowlet" or artifact-sense "module" survives in real code. The dying artifact
   layer's vocabulary is `SavedVendo` / `Vendo` / `Flow*` / `/vendos` / `saved_vendos` — it dies by deletion, not rename.
3. **The artifact layer is two parallel shapes that were never reconciled** (core `SavedVendo` vs shell `Vendo`)
   plus a third (remix pins + sealed-envelope fast-edit machinery). Full inventory below.
4. **Doc debt is localized**: four docs + one example teach the saved-library surface; `docs/contracts/seams.md`
   and the core/runtime READMEs canonize the pre-app architecture.
5. **No automation-artifact wrapper exists in packages** — automations persist in their own engine tables. The
   authoring surface (create_automation tools, prompt blocks) lives in the demo apps and is disabled there.

## Orchestrator rulings (flagged for Yousef where noted)

- **R1 — Shape approvals: KEEP, flagged.** ⚠️ The Notion page demoted shape approvals to "Future", but constrained
  grant scopes are already implemented and load-bearing for shipped safety UX (fade proposals, steering narrowing;
  ENG-193 / PR #40). Deleting shipped safety behavior is a product decision — left intact pending Yousef's call.
- **R2 — Remix/pinning machinery: DELETE.** It is pre-app-format artifact persistence (pins are saved artifacts;
  the page redefines pinning on published apps). Exception: the `<VendoRemix>` export survives as an inert stub
  (renders children, no pin swap) because `vendo init` spliced it into host source.
- **R3 — Automations engine: KEEP.** Scheduler, 3 trigger kinds (schedule/host-event/external), run models, engine
  tables stay. Only the authoring/creation surface is disabled (demo tools, prompt blocks) pending apps-with-triggers.
- **R4 — Live views: KEEP.** `render_view`, materialize-view, genui format, theme, shell surfaces, voice stay.
  Trimmed: `remixAnchorId` tagging, refreshable-views prompt section (wire field `queries` stays dormant).
- **R5 — Layering refactor: NOT in this pass.** Creating @vendoai/apps, moving `genui/`/`stub-agent`/`prompt/` out of
  core, extracting automations above apps, adding a layering CI guard — all Phase 1 (carve-when-you-touch). Recorded
  in "Phase 1 moves" below.
- **R6 — New artifact naming: deferred to the app-format spec.** Stubs stay name-neutral; "app" vs `VendoApp` etc.
  decided at spec time (note: bare "app" is maximally ambiguous inside host apps).
- **R7 — Frozen history stays frozen**: docs/superpowers records get a historical banner, contents untouched.
  gmail demo is a frozen prebuilt bundle (source not in repo) — untouched.

## Kill-list — WP1: artifact layer (packages + compile fixes)

Core:
- `core/seams/store.ts`: DELETE `SavedVendo`, `SavedVendoStore`, `RemixRecord`, `RemixStore`, and Store members
  `vendos`/`remixes` (keep threads/automations/audit/grants/rules).
- `core/protocol.ts`: DELETE remix wire protocol (`VendoMetadata.anchors`, `AnchorContextBlock`,
  `ResolvedRemixSource`, `RemixEnvelopePayload`, `AnchorRef`, `RemixSourceRecord`, `RemixSourceResolver`,
  `data-remix-envelope` part) + `EnvManifest` if only remix-consumed.
- `core/ui.ts`: DELETE `UINode.remixAnchorId`.
- `core/prompt/sections.ts`: DELETE `refreshableViewsSection`; unwire from assemblers. `genui/format.ts` `queries`
  field stays (dormant).

Runtime:
- `embedded/in-memory-store.ts`: DELETE `InMemorySavedVendoStore`, `InMemoryRemixStore`; trim factory/interface.
- DELETE `remix/` (baseline, envelope, hunks, bytes), `edit-view-tool.ts`; trim `render-view-tool.ts` +
  `materialize-view.ts` anchor tagging; excise `engine.ts` RemixContext/anchor prompt sections/seal wiring
  (~15 touch points) without disturbing the agent loop.

Store:
- DELETE `vendo-registry.ts`, `savedVendos` schema entry + exports; add forward migration dropping
  `vendo.saved_vendos` (do not edit migration history).

Server:
- DELETE `vendos.ts` route family (`/vendos*` → 404), `remix-enrich.ts`, `seal.ts`; trim `fetch-handler.ts`,
  `chat.ts`, `options.ts` (`remixSources`, `sealSecret`), `vendo-dir.ts` remix-sources loading; `capabilities.ts`
  `storage` flag reports absent.

Shell:
- DELETE `seams/store.ts`, `seams/web-storage.ts`, `seams/remixes.ts`, `seams/web-remixes.ts`, `seams/query.ts`,
  `reopen.ts`, `component-drift.ts`, `remix/snapshot.ts`, `remix/scope.ts`, `remix/page-context-registry.ts`,
  `voice/replay-registry.ts`.
- STUB: `FlowGallery` → removed from Landing (no saved-state UI); `VendoToast` deleted (demo-only consumer);
  `VendoRemix` → inert passthrough; `VendoThread` flows/library props + voice `open_saved_vendo` + "Pin to card" /
  "Apply to page" affordances removed; context trimmed (`store`, `remixes`, `scope`, `runQuery`,
  `refreshIntervalMs`, drift `components`).
- `use-vendo-thread.ts`: DELETE remix-envelope collection + `originatingPrompt`.

Client / umbrella / CLI:
- DELETE `client/server-store.ts`, `client/run-query.ts`; trim `vendo-root.tsx` wiring.
- Umbrella `vendo/src/index.ts`: drop `SavedVendo`/`SavedVendoStore`/`RemixRecord`/`RemixStore` re-exports.
- CLI: remix picker step removed from init/refresh/doctor (`remix/discover|step|anchor`), `sync/capture.ts`
  remix-sources capture removed. Extraction/theme/tools = untouched.

Demo/example compile fixes (mechanical only in WP1; coherence in WP5):
- demo-bank: `saved-vendos.ts`, `automations.ts`, `poller.ts` + poll route deleted; `/vendo` page → chat-only;
  VendoRoot/VendoLayer/handler-options/agent/reset trimmed.
- demo-accounting: `saved-vendos.ts`, `automations.ts`, tick/deliveries/resume/parked-actions routes deleted;
  assistant page → chat-only + trust plane (grants/rules/audit rows only); VendoRoot/VendoLayer/chat-handler/agent/
  tool-registry/trust-handler trimmed; `deadline-list.tsx` unwrapped; `.vendo/remix-sources.json` + `remixAnchors`
  config removed.
- examples/shell: Element 03 saved-slot section removed.

## Kill-list — WP4: docs

- REWRITE: `docs/contracts/seams.md` (post-deletion seam reality + pointer to app-format direction; fix "five seams"
  count), `docs/persistence-and-deploy.md` (excise saved-vendos sections), `packages/vendo-runtime/README.md`
  (no standalone-agent framing, no ticket archaeology), `packages/vendo-core/README.md` (drop "frozen 2026-07-01"
  framing; note Phase-1 layering direction).
- TRIM: `docs/host-components.md` (saved-vendo versioning half), `docs/quickstart.md` (vendos routes + persistence
  promise), `packages/vendo-cli/README.md` (ENG-198 refs), `apps/demo-bank/README.md` (automation copy + ENG-178
  closing), CLI `.vendo/` README template (ENG refs), root `CLAUDE.md` package list.
- DELETE: root `WORKER-REPORT.md`.
- ADD: "historical record" banner atop the 12 `docs/superpowers/` plans/specs. Fix seam docstrings referencing
  nonexistent `apps/cloud`.

## Kill-list — WP5: demo coherence

- Both demos: hero suggestions + system prompts must not offer saving/automation-creation/remix; replace with
  live-view + read + approval beats. Policy allowlists trimmed. Reset routes reduced to reseed+connections.
- Lost until Phase 1 (accepted): Maple Slack-snitch + auto-saved tabs; Cadence morning-chase automation beat,
  ✦ customize/remix, saved tabs, automation rows in Trust. Surviving: reads, live generated views, dashboard slot,
  voice, doc-chase, uploads + wrong-document catch, consent/grants/rules/audit.
- Verify demo-bank boots after cleanup.

## Phase 1 moves (recorded, not executed)

- Create `@vendoai/apps`; move core `genui/` (~520 lines), `stub-agent.ts`, `prompt/` machinery there; core loses its
  `ai`/`@ai-sdk/provider` hard deps and becomes contracts-only.
- Extract automations above apps (`automation = app with a trigger`); re-skin automation persistence onto the app format.
- Add a layering CI guard (current dependency-guard only protects runtime portability; real graph has cross-block
  edges: store→runtime, shell→react, react→stage, server→{runtime,shell,store,telemetry}).
- Rebuild on the app-format spec: saving, sharing (frozen snapshot), library, pinning-on-published-apps, remix
  fast-edits (the deleted engine's ideas — sealed envelopes, hunk edits, prepared baselines — are worth reusing).
- Reclaim the word "manifest" (`docs/contracts/manifest.md` = host install manifest vs the app manifest).
- Consider renaming the local `~/orca/workspaces/flowlet/` dir (path strings leak into build artifacts).

## Environment notes

- `apps/showcase` does not exist on this branch. `apps/gmail` is a frozen prebuilt bundle (2 cosmetic "flowlet"
  hits live in a committed sourcemap; erased whenever that bundle is regenerated or removed).
