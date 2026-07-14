# Production-grade UI generation — design

**Date:** 2026-07-14
**Linear project:** [Production-grade UI generation](https://linear.app/runvendo/project/production-grade-ui-generation-b537899c7971)
**Status:** Approved by Yousef (section-by-section, 2026-07-14)
**Orchestrator:** ui-generation Orca session (this worktree). Execution delegated to codex sol (Opus 4.8 only when sol is blocked by usage limits).

## Outcome

Generated UI indistinguishable from host-shipped screens, at production speed, on
all generation surfaces (first generation in chat, remix/edits, saved apps,
automation-produced UI, voice-driven UI).

## Bars (the definition of done)

- **Latency:** p95 first meaningful paint of generated UI **< 1s** after the
  generation tool call; **usable view < 10s** (core content interactive; edges
  may still fill). Quality is not sacrificed to hit this. Enforced by CI bench
  gates plus runtime spans.
- **Fidelity:** token-level match guaranteed (host colors, fonts, radii,
  spacing), host-component integration working (model composes the host's own
  registered components). A designer squinting can't tell.
- **External gate:** 5 corpus repos each render generated UI that looks
  native — screenshot harness output with **Yousef's visual sign-off per
  repo**. (Amended 2026-07-14: only 4 were bootable; gate = umami, skateshop,
  papermark + one extraction-project flagship fixture (Rallly/Twenty/NextCRM/
  teable, pick pending the extraction session's recommendation) as the 5th.
  The synthetic express-host is out of the sign-off montage.)
- **Demo GIFs (all required):** streaming first-paint beat on Maple + Cadence
  with visible timer; host-component beat (model picks e.g. MapleSparkline
  from the catalog); remix/edit beat with no blank-iframe regressions; corpus
  montage (5 repos side-by-side with real host screens).

## Grounding (measured 2026-07-14)

Pipeline examination and live measurement on demo hosts (Sonnet 4.6):

- Generation is fully buffered: the engine uses blocking `generateText`
  (`packages/apps/src/engine.ts:129`); the renderer already supports partial
  trees with skeletons (`packages/ui/src/tree/renderer.tsx:154`) but nothing
  feeds it. Direct `streamText` TTFB ≈ 0.9s.
- Live cost of a UI-generating request: **~90–145s** agent time; first
  generated pixel at 63–103s; plus a blocking write-approval card (15–30s to
  reach it). Simple non-UI answers: ~13s.
- Host-component catalog is hardcoded empty (`packages/vendo/src/server.ts:684`
  `catalog: []`, no config surface) — the model can never emit `source:"host"`
  nodes despite full renderer support.
- Theme extraction fills only 8 slots; dark mode detected then discarded;
  measured misses on Maple: `system-ui` extracted where the host uses Inter,
  radius 14px vs host 8px, accent `#0A7CFF` vs host black.
- Fidelity tells in screenshots: emoji everywhere (hosts use zero), saturated
  green/red/indigo palette vs Maple's muted navy/brown/slate on identical data.
- Product bugs: JailedComponent auto-height broken (8192px iframe, ~6800px dead
  scroll); `vendo_apps_edit` unreliable (blank iframe → forced full rebuild +
  second approval); demo threads 404 after restart (triaged OUT — owned by the
  block-ui project).
- No runtime timing instrumentation exists in the generation path; offline
  `bench/` only. The pre-v0 32s→4.4s remix machinery did not survive the
  rewrite; no remix bench exists.

## Workstream 1 — Streaming & latency (child session `gen-streaming`)

- Engine: `generateText` → `streamText` with incremental tree parsing; partial
  trees ride the existing SSE stream as delta view-parts; renderer paints
  progressively (skeletons for dangling ids).
- Approvals: rung-1 UI creates (no server code, no egress) become read-class —
  auto-approved, no card. Approvals stay for server-code rungs and external
  writes.
- Slim the generation contract: leaner prompt, catalog/primitives preferred
  over generated jailed code, smaller trees.
- Parallelize `open()` query resolution (`packages/apps/src/open.ts:136`);
  resolve queries as they stream in rather than after full tree.
- Fix `vendo_apps_edit` blank-iframe reliability; harden the tree-ops fast path.
- Instrumentation: runtime spans (agent turn → engine TTFB → tree complete →
  queries → paint) + CI bench gates (p95 first-paint < 1s, usable < 10s) + a
  remix bench.
- Model strategy: stream + slim with the strong model first, then re-measure.
  Tiering (fast edit model etc.) only if still short of targets — the contract
  already permits a faster edit model; wiring it is the fallback lever.

## Workstream 2 — Host-component catalog (child session `gen-catalog`)

- Catalog schema per component: name, prop JSON-schema, when-to-use
  description, usage example.
- Two fill paths: **explicit registration** in `createVendo` config mirroring
  the client-side `components` map, and **auto-extraction** during init/sync
  (deterministic AST scan for names/props; AI only for when-to-use summaries).
  Exact deterministic-vs-AI balance and registration DX are being finalized
  jointly with the **extraction** and **install-dx** Orca sessions (messages
  sent 2026-07-14; their replies fold into this stream's plan).
- Wire the catalog into the engine prompt so the model emits `source:"host"`
  nodes; validate emitted props against the schema.
- Prove on Maple (MapleSparkline, MapleSpendingDonut) and Cadence.

## Workstream 3 — Theming & fidelity (child session `gen-fidelity`)

- Widen extraction to fill ALL `VendoTheme` slots (border, danger, accentText,
  headingFamily, density, motion) and fix the measured misses (font, radius,
  accent).
- Dark mode end-to-end: light+dark pairs through extraction → prompt → CSS
  vars → jail.
- Derived extended palette: extraction derives brand-harmonized data-viz
  series + status tints; generated code is constrained to theme vars + this
  palette (freedom within brand, still enforceable). No bare hard lint — the
  palette IS the escape hatch.
- Branded primitive kit v1 (core 8): Card, Button, Input, Select, Table,
  Badge, Stat, Tabs — token-themed, rendered outside the jail, so most views
  compose from branded blocks instead of from-scratch jailed code.
- Prompt fidelity rules: no emoji, host icon conventions, density matching.
- Fix JailedComponent auto-height (8192px bug).

## Workstream 4 — Verification harness (child session `gen-verify`)

- Corpus screenshot harness: boot the 5 live-verified corpus repos with Vendo
  integrated, drive standard generation prompts, capture screenshots + GIFs.
  Yousef signs off per repo — that sign-off is the gate.
- Owns capturing the four required demo GIFs.
- Harness build starts early; its gate runs last.

## Execution structure

- Four child Orca sessions (`gen-streaming`, `gen-catalog`, `gen-fidelity`,
  `gen-verify`), each a Fable orchestrator owned, monitored, and coordinated by
  this parent session via Orca orchestration messaging/tasks. codex sol
  executes; Opus 4.8 only when sol is blocked.
- Order: gen-streaming first; gen-catalog and gen-fidelity in parallel;
  gen-verify harness early, gate last.
- Linear: one issue per workstream + one per in-scope bug, in the existing
  project (no milestones/sub-projects).
- Cross-project boundary with **block-ui** (also editing `packages/ui`):
  proposed split — block-ui owns `chrome/*` + `chrome-css.ts`; ui-generation
  owns `tree/*` + `theme.ts`; negotiated directly between the two orchestrator
  sessions (Yousef delegated), coordination message before any cross-zone edit.

## Out of scope

- Thread persistence after restart → block-ui project (repro handed over).
- Hard theme-token lint with no escape hatch → replaced by the derived-palette
  constraint.
- Model tiering / speculative drafts → fallback lever only, after re-measure.
- Auto-extraction beyond the catalog (full design-system inference) → later.

## Decision log (Yousef, 2026-07-14)

1. Fidelity bar: token-level for sure, component-level integration too.
2. Latency: perceived-instant → hardened to p95 <1s paint / <10s usable, no
   quality sacrifice.
3. Scope: all generation surfaces.
4. External bar: corpus repos (screenshot harness, start with 5 live).
5. Streaming approach: stream the engine first (keep two-call architecture).
6. Catalog: auto-extract + explicit registration, maybe part of init; joint
   design with extraction + install-dx sessions.
7. Theme scope: widen extraction, branded primitives, dark mode. Off-theme
   colors handled by derived palette, not a hard lint.
8. Model strategy: stream + slim first, re-measure, tier only if short.
9. Approvals: auto-approve pure UI creates; keep for server rungs/writes.
10. Bugs in scope: iframe auto-height, apps_edit reliability. Persistence out.
11. Structure: child sessions per stream; Linear issues per stream; sessions
    negotiate the packages/ui boundary with block-ui.
