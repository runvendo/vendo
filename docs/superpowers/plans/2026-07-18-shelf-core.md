# Lane A: Shelf Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `@vendoai/ui` chrome into the converged shelf: overlay as pure chat with a clean seam structure, thread refactored into small per-piece files, Slot with a `remix` flag and pin self-discovery, palette demoted to a self-sufficient optional extra.

**Architecture:** Presentation-only restructure of `packages/ui/src/chrome/` — no wire, hook-contract, or tree-renderer changes. The refactor is behavior-preserving (existing tests must keep passing) and produces the small-file layout that the wave-2 eject lane will copy verbatim.

**Source of truth:** `docs/brainstorms/ui-usage-dx.md` (decisions §1–§5). Read it first. Do not re-open decided questions.

**Hard boundaries:** Do not touch `packages/ui/src/tree/` (microapps-v2 lanes own the renderer seam). Do not change wire types or hook signatures except where this plan says so. Never commit to main; open a PR from this lane's branch.

---

### Task 1: Thread refactor into per-piece files

**Files:** split `packages/ui/src/chrome/vendo-thread.tsx` (~1,118 lines) into a `packages/ui/src/chrome/thread/` directory: an index exporting `VendoThread` with its existing props, plus focused files for the message list, a single message/bubble, stream-part rendering (generated views, approvals, connect cards, tool/thinking lines), the composer, and scroll/status management. Keep `@vendoai/ui/chrome` exports identical.

- [ ] Map the current file's internal sections and draw the split boundaries before moving code
- [ ] Move code section-by-section, one commit per extracted file, keeping the suite green after each commit
- [ ] Verify the public export surface is unchanged (existing chrome tests + a type-surface check)
- [ ] Browser-verify VendoThread in demo-bank `/vendo` (stream a turn, approval card, generated view) with screenshots

### Task 2: Overlay thread-injection seam

**Files:** `packages/ui/src/chrome/vendo-overlay.tsx`

- [ ] Add an optional `thread` prop (component) that the overlay panel renders in place of the built-in `VendoThread` — the one sanctioned component-injection point (eject seam)
- [ ] Test: overlay renders a custom thread component when supplied, built-in one otherwise
- [ ] Confirm overlay contains chat only — no management views; launcher on/off already exists and stays as-is

### Task 3: Slot pin self-discovery

**Files:** `packages/ui/src/chrome/vendo-slot.tsx`, new hook in `packages/ui/src/hooks/`

- [ ] Add a hook that resolves "the app/pin currently pinned to slot X" (poll `client.apps.list` the way demo-accounting's hero-slot does today; interval configurable, SSR-safe)
- [ ] `VendoSlot` uses it automatically when no explicit `appId`/`pin` prop is passed — hosts never write the polling dance
- [ ] Migrate demo-accounting's `hero-slot.tsx` off its hand-rolled SWR dance; browser-verify the pinned state still mounts (screenshots)

### Task 4: Slot `remix` flag

**Files:** `packages/ui/src/chrome/vendo-slot.tsx`

- [ ] `remix` prop renders the hover Remix affordance on the slot's filled/original content (port the pattern from demo-accounting's RemixButton, generalized)
- [ ] Activating it opens the conversation surface preloaded with a remix prompt for the slot's registered component (use the same global-registry pattern `openVendoPalette` uses; coordinate with Lane B's open-with-prompt registry — whichever lane lands second wires to the other's registry)
- [ ] Dev-mode warning when `remix` is set but the slot's component is not registered remixable
- [ ] Replace demo-accounting's hand-rolled remix button with the flag; browser-verify + screenshots

### Task 5: Palette demotion with a self-sufficient default

**Files:** `packages/ui/src/chrome/vendo-palette.tsx`, `docs/host-components.md`

- [ ] When no `onCommand` handler is supplied, default commands act instead of no-op: open the mounted overlay (via the overlay registry) for conversation commands; dev-mode console hint when no overlay is mounted
- [ ] Docs reposition the palette as an optional extra, not part of the default story

### Task 6: Mobile sheet pass

**Files:** `packages/ui/src/chrome/vendo-overlay.tsx`, `use-mobile-takeover.ts`

- [ ] Verify (and fix where short) that the overlay renders as a full-screen sheet on small viewports — the existing mobile-takeover hook is the starting point
- [ ] Browser-verify at a mobile viewport in demo-bank; screenshots in the PR

### Task 7: Docs + finish

- [ ] Update `docs/host-components.md` to the shelf framing (overlay = default pure chat; thread/page/slot placeable; palette optional)
- [ ] Full gates green: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
- [ ] PR with all screenshots; signal `needs-review` then `triage-complete` via worktree comment
