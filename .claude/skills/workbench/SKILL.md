---
name: workbench
description: Iterating on the vendo() harness or screen agent interactively — running the harness workbench, watching harness internals live (steps, compaction, guard, loadout), hot-reload edit loops on @vendoai packages, debugging a turn. Cross-ref: use genbench to MEASURE a change; workbench to FEEL and debug it.
---

# workbench

Maple (`examples/demo-bank`) plus whole-graph dev source aliasing plus a
dev-only internals pane behind `VENDO_WORKBENCH=1` (server env; unset means
zero diagnostic parts on the wire). Shipped in PR #1130.

## Run

    pnpm install && pnpm build       # once — dist must exist; @vendoai/store stays dist-pinned, so edits there need a rebuild
    VENDO_WORKBENCH=1 pnpm --filter demo-bank dev
    open http://localhost:3000

Pane docks right: Timeline / Context / Tools / Guard / Raw, plus a turn
selector.

## Loop

Chat → read the pane → edit `packages/*/src` (`loop.ts`, `compaction.ts`,
`vendo.ts` are the usual suspects — note `packages/harnesses/src/vendo/` is
an author-involved zone per its CLAUDE.md) → save → the next message runs the
edit. In-flight turns finish on the old code.

## Levers

- `MAPLE_HARNESS=context-e2e` — 32k context window, so a few messages reach
  compaction.
- Ask Maple to build something to watch a screen-agent run (tagged, 10-step
  cap).
- The "demo feed" button replays a canned turn for pane-UI work without
  spending tokens.

## Architecture, three lines

Harness sink `packages/harnesses/src/workbench.ts` → transient
`data-vendo-debug` parts (never persisted) → ui feed store
`packages/ui/src/chrome/workbench-store.ts` (20-turn retention) → pane in
`examples/demo-bank/src/components/vendo/workbench/`.

## Measuring

After a harness change, `pnpm build`, then the genbench skill for
before/after scores (genbench reads built dists).
