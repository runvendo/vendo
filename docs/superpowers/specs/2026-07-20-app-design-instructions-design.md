# App design rules — config key + live file reads

Status: APPROVED (Yousef, 2026-07-20); REVISED same day after seam discovery
Date: 2026-07-20

## Discovery that reshaped this spec

The first draft assumed the engine's `design-rules` prompt section was fixed
and proposed a new seam (`apps.instructions` + `.vendo/design.md` + a new
`host-design` section). Investigation showed the host seam already exists
end-to-end and is documented:

- `.vendo/design-rules.md` is read by the umbrella and passed as
  `createApps({ designRules })` (`packages/vendo/src/server.ts`).
- The engine renders it as the `design-rules` section (`HOST DESIGN
  RULES: …`) in BOTH the create pass and the edit pass
  (`packages/apps/src/engine.ts`).
- Documented in `docs-site/reference/dot-vendo.mdx`,
  `connect/instructions.mdx`, `connect/theming.mdx`, `concepts/prompts.mdx`.

Per the smallest-sufficient-mechanism rule, this spec now builds on that
seam instead of duplicating it. Two real gaps remain.

## Decision

1. **Live file reads.** `.vendo/design-rules.md` is read once at compose
   time today, so tuning the brief requires a server restart — bad DX for a
   file whose whole purpose is iterative tuning against generated output.
   Change: resolve the design rules lazily, per generation (create and
   edit). A file read costs microseconds. `brief.md` stays compose-time;
   it describes the product, which does not change per iteration.
2. **Config key.** Add `apps.designRules?: string` to `CreateVendoConfig`
   for hosts that prefer programmatic config over a `.vendo` file
   (serverless packaging, per-environment briefs). Named `designRules` — not
   `instructions` as first drafted — to match the existing seam's naming
   everywhere (file name, engine dependency, prompt section id). An explicit
   config string is fixed for the instance lifetime and wins over the file;
   empty/whitespace-only resolves to unset (fall through to the file).

## Behavior

- The umbrella passes the apps block a resolver: config string when set,
  else a per-call read of `.vendo/design-rules.md`.
- The engine's `designRules` dependency widens additively to also accept a
  provider function, resolved when the prompt sections are built (already
  per-generation). No section changes; no new prompt text.
- Unset stays exactly today's behavior: the section renders "(none
  provided)".
- No length cap. Docs note the brief spends generation-context budget.

## Out of scope (deliberate)

- The chat agent's system prompt (existing `system.instructions` seam) and
  `brief.md` read timing.
- Automation planning prompts.
- The existing-agents tool-pack contract (frozen 2026-07-20). Per-surface
  briefs on `vendoTools` are backlog, below.
- The live-eval spot-check from the first draft: steering through this
  section is already shipped behavior; this change is plumbing, so unit
  tests suffice.

## Testing

- Engine: provider-function form is resolved per generation — two
  generations observe different values when the provider's answer changes
  between them; string form still works.
- Umbrella: config key wins over the file; whitespace config falls through
  to the file; a `design-rules.md` edit after compose is picked up by the
  next generation; unset renders today's default.

## Docs

- Touch the four docs-site pages that mention `design-rules.md` to note the
  config key and that file edits apply live; sync the `docs/` mirror where
  those pages have counterparts.

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
- Dynamic per-principal brief (multi-tenant/white-label), first-class
  locale, app-creation quotas (check guard policy expressiveness first),
  embed build-beat copy override.
