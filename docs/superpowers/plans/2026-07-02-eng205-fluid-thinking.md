# ENG-205 Increment 1 — Fluid Thinking Indicator

**Goal:** Replace the shell's static three-dot "working" indicator with fluidkit's `Thinking` primitive (organic metaball motion) — the first visible piece of Flowlet's signature motion layer.

**Approach:** fluidkit stays an enhancement layer. The shell lazy-loads it at runtime; if the library is absent or fails to load, the existing static dots render unchanged. fluidkit itself already collapses to static dots under `prefers-reduced-motion` and pauses off-screen.

**Decisions (for Yousef to confirm at the increment review):**
- **Consume fluidkit `main`** (`d5e0fd6`, the tab-bar merge) — the touch-up branch has uncommitted aurora/mesh WIP, so main is the stable line.
- **Linkage: committed tarball** (`vendor/fluidkit-<version>-<sha>.tgz`, packed from a clean clone of main) referenced via `file:` from `@flowlet/shell`. Least fragile for this pnpm monorepo: works on any machine/CI, pins an exact artifact, no reliance on sibling checkout paths (which contain spaces). Refresh = repack + bump filename. The eventual npm publish of fluidkit removes this step entirely — flagged in findings.
- **Look:** `flat` material with the shell's muted foreground color (`currentColor`), sized to the current dots' visual weight. Glass/mercury need a colorful backdrop to read well; the chat thread is a flat surface. Material/size/speed are one-line prop changes for taste iteration after review.
- **Scope guard:** only the `.fl-typing` dead-air indicator changes. The activity-panel spinner, skeleton pulse, and everything else keep their current motion (later increments). Zero motion in the sandbox — untouched.

## Steps

1. **Vendor fluidkit.** Clone fluidkit main into scratchpad, install, build, run its test suite, `npm pack`. Commit the tarball under `vendor/` with a README documenting provenance (branch, SHA), the refresh procedure, and the npm-publish dependency.
2. **Wire the dependency.** Add `fluidkit` (file: tarball) and `motion` (its peer) to `@flowlet/shell`. Install, typecheck.
3. **FluidThinking component (TDD).** New shell component that renders the legacy static dots immediately and swaps to fluidkit's `Thinking` once the dynamic import resolves; on import failure it keeps the dots forever. Tests: absent-library fallback, loaded path (role=status), label passthrough.
4. **Swap into MessageList.** The dead-air `working` branch renders FluidThinking. Fallback keeps the existing `.fl-typing` CSS; add a wrapper class for the fluid variant. Test: working state shows an accessible "Working" indicator.
5. **Verify.** Full shell test suite, typecheck, build, lint. Then real browser via demo-bank: trigger a turn, confirm organic motion; confirm reduced-motion renders static dots (both fluidkit's internal collapse and the CSS fallback path); sample frame times to confirm no jank; note main-thread cost.
6. **Record.** `motion1-fluid.gif` (normal) and `motion1-reduced.gif` (reduced motion) at the worktree root.
7. **Document.** Findings doc (upstream API gaps if any, npm-publish flag, perf numbers). Sync docs.
8. **Checkpoint.** Commit, update Orca worktree comment, pause for Yousef's review via the orchestrator. No PR.

## Risks / notes

- Two motion libraries in demo-bank's page (host uses `framer-motion`, shell pulls `motion`) — same engine, different package names; bundle-weight note for findings, not a blocker.
- Dynamic-import state updates in jsdom tests can race test teardown; the component guards unmount, and tests await the resolved state explicitly.
