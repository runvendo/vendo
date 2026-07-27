# HANDOFF: harness (video-system)

compiled: 2026-07-26 · source: docs/superpowers/specs/2026-07-25-video-system-design.md
in the flowlet repo (signed 2026-07-25, amended + approved 2026-07-26) ·
branch: factory/video-harness

This file is your memory and your law. Re-read it after any restart or
compaction. The human is not available to you — you never ask them
anything. Genuine ambiguity this file doesn't answer → park it in
PARKED.md with evidence (exact command + output), take the most
reversible defensible default if you can continue, keep working other
tasks. You do not give up on tasks: failed approach → different
approach → systematic debugging → restart fresh from this file.
Stopping is for done or parked-with-evidence only.

## Goal

Turn the approved Remotion prototype at
`/Users/yousefh/factory-videos/one-click-proto/` (v3: detonation,
7-rule transition language, cursor system — all approved by Yousef)
into the permanent video harness INSIDE the vendo repo: a private
workspace package `tools/video-studio/` whose scenes render REAL
`@vendoai/*` components from `packages/` instead of hand-drawn mock
JSX, exposed as a reusable episode template so every future "State of
the art ___ in one click" video is a config + scenes, not a rebuild.
Done = the knowledge episode renders from real components at the same
pacing as the prototype, repo suite green.

## Orientation (do this before any work)
Summarize this contract back in 5 sentences into the Q&A below, note
any question that would improve the result, answer it yourself with
the most defensible default, and record both.

### Orientation Q&A

#### Contract in 5 sentences
1. Move the approved Remotion prototype at `/Users/yousefh/factory-videos/one-click-proto/`
   (14s / 30fps / 1920x1080, 420 frames, detonation + 7-rule transition language
   + cursor system) into the vendo repo as a private workspace package
   `tools/video-studio/`, without breaking `pnpm build/test/typecheck/lint`.
2. Then replace every hand-drawn mock of a *product* surface — chat panel,
   message bubbles, citation chip, assembling widget, generated-app
   presentation — with the REAL `@vendoai/*` components mounted on real
   providers and fed scripted static props (no network, no agent runtime).
3. Do the same for the host-side surfaces (settings row, dashboard grid, end
   state) using the actual Cadence (`apps/demo-accounting`) look, built from
   its real design tokens rather than eyeballed colors.
4. Refactor the composition into a reusable episode template so an episode is
   just `episodes/<name>.tsx` (scenes + copy + the "___" blank) and episode two
   takes <30 min, documented in a template README.
5. Prove it: render the MP4, extract frames at 0.3/0.9/1.5/3.0/6.5/8.4/11/13.5s
   into `docs/verification/video-harness/`, render a 3-scene 480p smoke episode
   to prove the template, run the full suite twice, write the RUN SUMMARY, open
   a PR without merging.

#### Conductor amendment (received mid-orientation, 2026-07-26) — ADOPTED
- **A1 — Cooler purple cursor.** The "port Cursor.tsx verbatim" pin is
  overridden for the cursor's VISUAL design only. New skin: brand violet
  `#6C3BFF` primary fill, 2px white outline, soft lilac `#A78BFA` glow, plus a
  2-3 frame fading motion trail while moving fast. Movement system (bezier
  waypoint paths, press scale, ripple, hotspot flash) stays byte-for-byte
  equivalent. Signature branded cursor, not a stock macOS arrow.
- **A2 — True real components, zero imitations.** Every agent-surface element
  must be the actual workspace component. If I catch myself rebuilding a
  product element as local JSX for looks, I mount the real one instead. If a
  component genuinely cannot mount, it gets PARKED with the exact error — never
  faked. Task-2 will be checked adversarially for import traceability.

#### Questions I would have asked, and my own answers

**Q1. Remotion needs deterministic, frame-locked rendering. The real thread is
driven by `ScriptedTransport`, which paces with wall-clock `setTimeout`, and
the real components animate with CSS transitions, `requestAnimationFrame`,
`ResizeObserver` and `scrollIntoView({behavior:"smooth"})`. Which timing model?**
A. **Frame-driven props, not wall-clock streaming.** I mount the real
components and compute their props/state from `useCurrentFrame()`. All entrance
motion is driven by the prototype's approved Remotion motion (`snap`,
`snapStyle`, `pushIn`), and the components' own wall-clock motion is disabled
(`theme.motion: "reduced"` → `--vendo-motion-duration: 0ms`; `restored` flag to
suppress the `.fl-item-in` CSS entrance). Rationale: the contract says pacing
and transitions must be *unchanged* from the approved prototype, and a
wall-clock transport would both change the pacing and make renders
non-reproducible. This is the most reversible choice — the components are real
either way; only the clock driving them is ours.

**Q2. `ThreadMessage`, `ThreadPart`, `TurnCitations`, `ThreadAppCard` and
`ensureChromeStyles` are NOT in `@vendoai/ui`'s public exports map (5 subpaths,
dist-only). Adding exports means modifying `packages/*`, which the guardrails
restrict. How do I get the real components?**
A. **Import `packages/ui` SOURCE directly, following the repo's own precedent.**
`packages/ui/e2e/harness/main.tsx` already imports `../../src/index.js`
rather than the package name. I do the same from `tools/video-studio`, with a
Remotion webpack override for `resolve.extensionAlias` (the source uses ESM
`.js` specifiers for `.ts`/`.tsx` files). This yields real components, keeps
`packages/*` untouched, and leaves imports trivially traceable to `packages/ui/src/...`
for adversarial checking. Modifying `packages/ui`'s exports map stays the
fallback, to be parked-with-error first if source import proves impossible.

**Q3. Generated app payloads render inside a sandboxed opaque-origin iframe
(`JailedComponent`) whenever a tree node has `source: "generated"`. Remotion
cannot reliably capture across that boundary. Fake it?**
A. **No — author the payload from the prewired/Kit vocabulary instead.**
`packages/ui/src/tree/renderer.tsx` enters the jail only for
`source: "generated"`; `prewired`/`host`/omitted render as plain React in the
host DOM through the same real `PayloadView`/`TreeView` renderer. So the widget
is still the genuine product renderer with a genuine `vendo-genui/v2` payload —
just composed from Kit components. If the iframe turns out to be unavoidable
for the shot, that gets parked with the exact failure, not replaced by a mock.

**Q4. Cadence (`apps/demo-accounting`) is a Next.js app with `next/font`,
`next/link`, `usePathname`, SWR data fetching and Tailwind v4 CSS-first tokens.
Task 3 says "import real components … if importable without hacks; else compose
from packages/ui primitives + the Cadence design tokens (real tokens from its
codebase)". Which branch?**
A. **The contract's own "else" branch, per component, honestly judged.**
`MissingDocsHero` is pure React with inline hard-coded Cadence hex and imports
nothing — that one is imported directly. `Sidebar`/`Topbar`/`DeadlineList`/
`AppShell` are Next-coupled (`next/link`, `next/headers`, `usePathname`,
`useRouter`) and SWR-driven; aliasing the Next router into Remotion is exactly
the "hack" the contract tells me to avoid, so those are composed from the real
Cadence tokens lifted verbatim out of `apps/demo-accounting/src/app/globals.css`
and `.vendo/theme.json`. Note the asymmetry with A2: A2's "zero imitations" law
is scoped to *agent surfaces* (task 2), where the contract demands real
components unconditionally; task 3 explicitly authorizes the token-composition
branch for the host chrome. Every token used is copied, never eyeballed.

**Q5. `apps/demo-accounting` has no Knowledge/Automations settings toggle — the
prototype's opening scene shows one. Where does that surface come from?**
A. Verified by grep: Cadence has no such row; the concept lives in
`apps/demo-bank`. The opening settings card is *host-side* chrome (task 3's
"settings row"), so I build it from the real Cadence settings-page `Row`/`Toggle`
markup and tokens, keeping the prototype's approved copy ("Knowledge" / "Give
your agent your docs, schema, and data" / "Enable"). Recorded rather than
parked, because the contract already tells me to compose host chrome from real
tokens when a real component isn't importable.

**Q6. Which pieces of the prototype are legitimately NOT product UI, and so
stay hand-authored?**
A. The video's own chrome: `Detonation`, `OrbWhip`, `WidgetFlight`, `Cursor`,
`theme.ts`, `chatShared.ts`, the kinetic type, the claim card, the end card, the
file chips of the eruption storm, and the `VendoMark` asset. These are motion
language and brand, not product surfaces — the contract pins them as CANON to
port verbatim (with the A1 cursor skin exception). "Zero imitations" applies to
product elements, not to the film grammar around them.

**Q7. Audio?**
A. Render silent, expose an `audioSrc?: string` slot on the episode
composition, per Pinned Interfaces. Soundtrack is another lane.

#### Working notes
- Worktree root: `/Users/yousefh/factory-worktrees/video-system-harness`
  (branch `factory/video-harness`). Prototype at
  `/Users/yousefh/factory-videos/one-click-proto/` is READ-ONLY — copy, never modify.
- `pnpm install` at the worktree root: green, 37.4s, pnpm 11.10.0.
- Repo already had `tools/demo-router`, so `tools/` is an established home;
  but `pnpm-workspace.yaml` does NOT glob `tools/*` — extending it is in-scope
  per task 1.

## Pinned interfaces

- The 7-rule transition language and 14s/30fps/1080p skeleton from the
  spec amendment are CANON — port the prototype's implementation
  (Detonation.tsx, OrbWhip.tsx, WidgetFlight.tsx, Cursor.tsx, theme.ts,
  chatShared.ts); do not redesign motion.
- Brand: violet #6C3BFF / lilac #A78BFA / ink #0E0B1A / Onest; the real
  mark SVG already in the prototype (`public/brand/vendo-mark-violet.svg`).
- Leave an `audioSrc?: string` slot on the episode composition (Audio
  track mixes in later; soundtrack is another lane — render silent).

## Tasks

1. **Walking skeleton — prototype lives in-repo.** Create
   `tools/video-studio/` as a private pnpm workspace package in a new
   worktree branch `factory/video-harness`; port the prototype
   verbatim; `pnpm --filter video-studio render` produces
   `tools/video-studio/out/one-click-knowledge.mp4` (14s, 1920x1080,
   30fps) identical in content to the prototype render. Repo
   `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green
   (check dependency-guard/lint config treats tools/ correctly; if the
   workspace globs exclude tools/, extending them is in-scope).
   Proves: the studio can live in the repo without breaking anything.
2. **Real components — agent surfaces.** Explore `packages/ui` (and
   sibling packages) for the REAL thread/chat, message, approval-card,
   and generated-app presentation components (the ones the product
   actually renders; search before assuming names). Replace the mock
   chat panel, message bubbles, citation chip, and assembling widget
   scenes with those real components driven by scripted props/state
   (static data files, no network, no agent runtime). Where a component
   needs providers/context, build the minimal real provider wiring
   (VendoRoot or equivalent) — not a visual copy. Criteria: frames at
   3.0s and 6.5s show the actual product components (compare class
   names/DOM in the Remotion preview against packages/ui source);
   pacing/transitions unchanged.
3. **Real components — host dashboard.** For the settings row, the
   dashboard grid, and the end state, use the demo hosts' actual look:
   import real components from `apps/demo-accounting` (Cadence) if
   importable into the studio without hacks; else compose from
   packages/ui primitives + the Cadence design tokens (real tokens from
   its codebase, not eyeballed). Criteria: the dashboard scene reads as
   the Cadence product; no invented UI languages.
4. **Episode template.** Factor the composition so an episode is:
   `episodes/<name>.tsx` (scenes + copy + the "___" blank) plugging
   into the shared template (detonation → eruption → proofs → claim →
   end card + camera law + cursor). The knowledge episode is episode
   one; template README documents how to add episode two in <30 min.
5. **Evidence + PR.** Render final MP4; extract frames at 0.3/0.9/1.5/
   3.0/6.5/8.4/11/13.5s; put MP4 path, frames, and a side-by-side note
   (prototype vs real-components) in `docs/verification/video-harness/`;
   RUN SUMMARY in progress.md; open a PR (do NOT merge; factory-check
   runs first).

## Contract criteria (tier 1 unless noted)

- Given a clean checkout of the branch, when
  `pnpm install && pnpm --filter video-studio render` runs, then
  `tools/video-studio/out/one-click-knowledge.mp4` exists, is 14s ±0.5s
  1920x1080@30fps, and its 3.0s/6.5s frames render real `@vendoai/*`
  components (verifiable in source: scenes import from workspace
  packages, zero hand-drawn chat/widget mocks remain).
- Given the repo root, when `pnpm build && pnpm test && pnpm typecheck
  && pnpm lint` run, then all green.
- Given the template, when a new episode file with different copy/blank
  is added per the README, then it renders without touching template
  files (prove with a 3-scene smoke episode rendered at 480p, kept in
  evidence only).

## Guardrails
- Never weaken/delete/reinterpret a criterion — park with evidence.
- Your worktree/branch only; never main; never another lane's files.
- No prod data, no network calls in compositions, no secrets, no spend.
- One dev/preview server; kill what you start.
- Do not modify `packages/*` source except where a component genuinely
  cannot mount outside the app (park it first with the exact error; a
  minimal, additive export is the only acceptable change).
- Never edit this file above the Q&A section.

## When done
All criteria pass, full suite green twice → evidence folder populated
(frames are the E2E proof for a video lane) → RUN SUMMARY at the top of
progress.md (impact first, per-task status, parked items with evidence,
exact commands to see it work) → exit report: impact one-liner ·
per-task status · evidence paths · parked items · deviations ·
unrelated issues noticed (never fixed).
