# App design instructions — host design brief for generated UI

Status: APPROVED (Yousef, 2026-07-20)
Date: 2026-07-20

## Problem

Hosts have no way to steer the look-and-feel of generated apps. The engine's
prompt sections (`role`, `tree-contract`, `component-styling`, `catalog`,
`theme`, `design-rules`, `remixable-slots`, `prewired-props`) are entirely
fixed; the only host-controlled text reaching generation is the per-request
prompt the calling agent writes. A host who wants "dense layouts, no emoji,
EUR currency, always an export button" has nowhere to say it once.

This matters doubly for the existing-agents seam: hosts running their own
agent hand app generation to Vendo's engine wholesale, so a global design
brief is their only steering surface.

## Decision

One freeform design brief per Vendo instance, expressed two ways with a
fixed precedence:

1. `apps.instructions` — a new optional string key on `CreateVendoConfig`,
   alongside the existing apps-block flags. Named to mirror the agent
   contract's `system.instructions`.
2. `.vendo/design.md` — read from disk as the default when the config key is
   unset, through the same `dotVendoFile` mechanism that already serves
   `.vendo/brief.md`. Explicit config always wins. Empty or whitespace-only
   values (either source) resolve to unset.

Freeform prose was chosen over a structured options object and over
exemplar-based few-shot: smallest surface, matches the `system.instructions`
precedent, and structured keys can layer on later if real usage shows
recurring fields. (Decided 2026-07-20.)

## Behavior

- The umbrella threads a brief resolver into `createApps`. An explicit
  `apps.instructions` string is fixed for the instance's lifetime;
  `.vendo/design.md` is read lazily per generation (a file read costs
  microseconds), so editing the file applies to the next create/edit without
  a server restart — unlike `brief.md`'s compose-time read, because a design
  brief is tuned iteratively against generated output.
- The engine adds one new prompt section, `host-design`, placed after the
  built-in `design-rules` section so host guidance reads as a refinement
  layered on Vendo's defaults.
- The section is included in BOTH the create pass and the edit pass. A brief
  that applied on create but vanished on "make it more compact" would be a
  bug, not a smaller scope.
- All three creation routes converge on the same engine — Vendo chat,
  `vendo_create_app` from a BYO agent loop, and `vendo_delegate` — so every
  route picks up the brief with no per-route work.
- Unset means the section is simply absent, exactly how the `theme` and
  `catalog` sections behave today. Nothing to fail closed on.
- No length cap. Docs note that the brief spends generation-context budget.

## Out of scope (deliberate)

- The chat agent's system prompt — that is the existing `system.instructions`
  seam in the agent contract, not this one.
- Automation planning prompts.
- The existing-agents tool-pack contract (frozen 2026-07-20). Per-surface
  briefs on `vendoTools` are backlog, below.

## Testing

- Unit: section present when configured; absent when unset; file fallback
  works; config wins over file; whitespace resolves to unset; edit pass
  includes the section; a design.md edit after compose is picked up by the
  next generation.
- One eval-harness spot-check via `docs/eval` (the generation-eval front
  door): a brief like "no emoji, dense tables" is visibly honored in a
  generated app. Prompt-section unit tests alone don't prove steering works.

## Docs

- `docs/` page for the seam plus docs-site sync (both sides updated together
  per the existing mirror rule).
- `.vendo/design.md` mentioned wherever `.vendo/brief.md` is documented
  (init/quickstart). A future `vendo init` stage may author a starter
  `design.md`; not part of this work.

## Backlog (recorded, not built)

Ideas from the same brainstorm, deferred until demand shows up:

- Pack-level per-surface briefs (`vendoTools` option) — different design
  guidance per integration surface. Touches the frozen pack contract.
- `style_hints` field on `vendo_create_app` — the host's agent passes
  per-request design intent from conversation context.
- Tool description overrides on the pack — hosts steer their own agent's
  tool selection.
- `vendoSystemHint()` helper — a paragraph hosts paste into their agent's
  system prompt explaining when to reach for Vendo tools.
- BYO-loop app-edit gap — the pack has create and delegate but no edit tool;
  "tweak the dashboard you just made" said in the host's chat has no direct
  route today. Possibly a real gap rather than an option.
- `onAppCreated` telemetry hook — lets hosts observe prompts/results while
  tuning their brief.
- Catalog preference metadata (`preferFor`) — component-choice steering as
  data rather than prose.
- Per-pack model/paint overrides.
