# Agentic UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement every decision in `docs/superpowers/specs/2026-08-02-agentic-ui-redesign-design.md` (16 sections) across `packages/ui` + the small engine/plan-dialect touch, on top of `rebuild/cutover`.

**Architecture:** One foundation lane rewrites the design tokens/recipes in `chrome-css.ts` (S1 as a recipe over host theme tokens) and adds the shared card-shell CSS; six parallel lanes then build on it — cards, transcript, background/attention, V4 display hint, the center page, and the reference/gates lane. `chrome-css.ts` is append-only for wave-2 lanes (marked lane sections at EOF); the conductor reconciles at merge.

**Tech Stack:** React 18 chrome in `packages/ui` (fl-* classes, VendoTheme tokens), render seam in `packages/harnesses`, generation plan dialect in `packages/apps`, Playwright for proof GIFs.

**Base branch:** `rebuild/cutover` → integration branch `redesign/ui-s1`; one PR per lane onto the integration branch, final PR `redesign/ui-s1 → rebuild/cutover`.

**Standing proof rule (Yousef requirement):** every UI lane commits GIFs/screenshots to `docs/superpowers/evidence/2026-08-03-ui-redesign/<lane>/` (Playwright video → gif) AND exposes a clickable `fleet preview` URL. No lane closes without visual proof captured from a real browser run of demo-bank.

**Pilot-lesson mitigations (machine0):** gates run FOREGROUND and finish before a worker ends its turn (never "running in background, will check later"); workers use `secret` for keys; conductor diffs `chrome-css.ts` + `packages/ui/src/chrome/index.ts` against fresh integration branch before every merge; `fleet ask` never relied on synchronously.

---

## Wave 1 — Lane A: `s1-foundation` (serialized; everything depends on it)

**Files:**
- Modify: `packages/ui/src/chrome/chrome-css.ts` (the whole aesthetic layer)
- Modify: `packages/ui/src/chrome/share-dialog.tsx` (dead class names)
- Modify: `packages/ui/src/theme.ts` (only if a new derived token is needed — prefer deriving inside the sheet via color-mix)
- Test: `packages/ui/src/chrome/s1-recipe.test.ts` (new)

### Task A1: S1 recipe re-token
- [ ] Rewrite the derived-token block at the top of `.vendo-root` in `chrome-css.ts` to the S1 recipe, ALL derived from host tokens (spec §11 + §S1-recipe): `--vendo-border: color-mix(in srgb, var(--vendo-color-text) 8%, transparent)` (hairline ≈5–8% of fg), `--vendo-border-strong: 14%`, muted text mixes as today, radius scale = `--vendo-radius-small/medium` host tokens with card=medium+4px composer=26px rows=10px (derive via calc from medium so a square-brand host stays square), shadow tokens: `--vendo-shadow-float` (composer/toasts/tiles-hover only) and NOTHING else.
- [ ] Retire frosted glass: remove every `backdrop-filter`/`-webkit-backdrop-filter` and `--vendo-glass*` usage; surfaces become flat `--vendo-color-surface`/`background`.
- [ ] M2 motion tokens: `--vendo-motion-duration: 380ms`, easing `cubic-bezier(0.32,0.72,0,1)`; entrance keyframes get soft blur-to-focus (`filter: blur(5px)`→0, translateY(10px)→0); reduced-motion + `theme.motion:"reduced"` keep working.
- [ ] Build-calm (spec §8): during `data-state="building"` the ONLY animated element is `.fl-boot-hairline`; delete the `.fl-appcard-dot` building pulse, the skeleton shimmer loop, and stop `.fl-beat-orb` pulsing (static orb; "…" text carries working state).
- [ ] Test `s1-recipe.test.ts`: render the sheet string and assert — zero `backdrop-filter` occurrences; hairline border rule uses color-mix off `--vendo-color-text`; exactly one `animation:` rule scoped under `[data-state="building"]`.

### Task A2: dead CSS + unmatched classes (audit §16.3)
- [ ] Delete the dead families listed in the audit (`.fl-tool*`, `.fl-trust*`, `.fl-auto-created-*`, `.fl-auto-approval-*`, `.fl-auto-access-*`, `.fl-auto-summary*`, `.fl-connect{,-head,-ic,-done-dot}` dead halves, `.fl-approval-{unverified,outcome,declined,reason,--escalation}`, `.fl-waiting-stale`, `.fl-receipt*`) after grepping each for zero TSX consumers.
- [ ] Fix `share-dialog.tsx` `.fl-btn--primary`/`.fl-btn--ghost` → `.fl-btn-primary`/`.fl-btn-quiet`; add the missing `.fl-approval-heading { min-width: 0 }` rule; remove or style `.fl-beat-working`, `.fl-ribbon--working`, `.fl-buildfail` (style them — they're used).
- [ ] Deduplicate `.fl-approval-desc` (keep one) and `.fl-approval-consequence` (keep the §8-consistent one).

### Task A3: card-shell CSS primitives (consumed by Lane B)
- [ ] Add ONE `.fl-card-*` family: `.fl-cardshell` (padding 16/18, radius from recipe, flat surface, hairline border), `.fl-card-head` (flex, 11px gap, min-width 0), `.fl-card-ic` (28px well — the ONE size), `.fl-card-eyebrow`, `.fl-card-title`, `.fl-card-line` (the plain-words line), `.fl-card-fields` + `.fl-card-field` (dt/dd grid, money right where dd is numeric), `.fl-card-list`, `.fl-card-actions`, `.fl-card-byline`. Exactly one primary button style remains: `.fl-btn-primary` (+ `.fl-btn-ceremony` for destructive only; delete `.fl-btn-critical`).
- [ ] Ancestors may only set width/max-width on `.fl-cardshell` — replace the sheet's undressing rule (`chrome-css.ts` ~2270) with width-only overrides.

### Task A4: gate + proof
- [ ] `pnpm build && pnpm test && pnpm typecheck && pnpm lint` green (foreground).
- [ ] Capture before/after: run demo-bank, Playwright-record a thread turn + open panel; commit GIF + PNGs to `docs/superpowers/evidence/2026-08-03-ui-redesign/lane-a/`. Post `fleet preview` link for demo-bank.
- [ ] Commit per task; PR `redesign/lane-a-s1` → `redesign/ui-s1`, auto-merge when green.

---

## Wave 2 (parallel after A merges; chrome-css.ts is APPEND-ONLY, one marked section per lane at EOF)

### Lane B: `card-shell` (spec §16)
**Files:** Create `packages/ui/src/chrome/card-shell.tsx`; Modify `approval-card.tsx`, `grant-set-card.tsx`, `connect-card.tsx`, `adoption-card.tsx`, `automation-card.tsx`, `waiting-queue.tsx`, `approval-sheet.tsx`, `embeds.tsx`, `voice/voice-consent.tsx`, `thread/parts.tsx` (descriptor synthesis), `chrome-root.tsx` (policy notice gating), `build-beat.tsx` (toolPresentation stays the single humanization source); Test: `card-shell.test.tsx`, `approval-degraded.test.tsx`.

- [ ] B1: Build `<CardShell>`/`<CardHead>`/`<CardFields>`/`<CardList>`/`<CardActions>` on the `.fl-card-*` primitives; eyebrow strings become a single `CARD_EYEBROWS` map (approval / automation-approval / connect / standing-access / automation-status / paused-adoption / resolved).
- [ ] B2: Migrate the five card kinds + `ResolvedApprovalCard` + voice automation consent onto the shell (contents only, zero bespoke geometry). `WaitingRow` and the voice consent strip become thin wrappers rendering the SAME shell (compact width via ancestor, never undressed).
- [ ] B3: Data hardening — thread approvals carry the real descriptor: extend the wire part builder in `parts.tsx:506` to pass through `inputSchema`/`title`/`description` from the tool registry part payload (and the stream part where present) instead of `inputSchema: {}`; `argValue` money path gets an integration test: the $47.50 case renders `$47.50` IN-THREAD. Server `inputPreview` is never rendered on end-user surfaces — the queue row humanizes args client-side via the same `preview()` used in-thread; raw fallback only behind `dev-mode`.
- [ ] B4: Consumer-voice — `automaticPolicyNotice` never renders on end-user surfaces (gate to dev-mode/console surfaces); every remote-logo `<img>` gets the ConnectCard `onError` fallback glyph (extract one `<ToolkitLogo>`); adoption/refusal copy paths keep consumer sentences (no `reason.message` passthrough anywhere — grep-audit as a test).
- [ ] B5: Degraded-data test matrix (this IS the bug's regression suite): empty schema · nested args · >8 fields · connector slug names · logo 404 · missing ToolMeta — snapshot each through the REAL components; plus gates green, GIF of approve flows (thread + queue + sheet) to `evidence/lane-b/`.

### Lane C: `transcript-agentic` (spec §1, §8, §15)
**Files:** Modify `thread/parts.tsx`, `thread/message.tsx`, `thread/message-data.ts`, `thread/index.tsx`, `build-beat.tsx`; Test: `transcript-beats.test.tsx`.

- [ ] C1: Successful tool parts render `BuildBeat` in-transcript (reversing lane pick C1; keep `collapseToolRuns` ×N). Results suffix: reuse humanized short result where the part output offers one (count/id line), else none.
- [ ] C2: On turn settle, beats collapse into one reopenable summary row "✓ Did N things · Xs" (component `BeatSummary` in `build-beat.tsx`; measures wall time from first beat part timestamps; expanded state per-turn, default collapsed for restored turns).
- [ ] C3: D1 — the apps create/edit call that produced a `data-vendo-view` part renders NO beat (the app card is the step); the summary still counts it.
- [ ] C4: StatusRibbon drops tool-call narration (transcript owns it); `WorkingRibbon` (between-steps) and approval-wait line stay; errored calls keep ✕ beats; NO failure components (spec §15) — assert via test that no retry buttons/chips exist in failure renders.
- [ ] C5: Gates green + GIF of a live multi-tool turn (beats → collapse) and a fault-injected failing turn (✕ beat + prose continues) to `evidence/lane-c/`.

### Lane D: `background-attention` (spec §2, §3, §4)
**Files:** Modify `vendo-overlay.tsx` (pill states, close-mid-run), `vendo-toasts.tsx`/`morph-toast.tsx` (completion toast), `waiting-queue.tsx` (count-first strip on Lane B's shell), `hooks/use-vendo-status.ts`/`use-approvals.ts` (counts); Test: `pill-states.test.tsx`.

- [ ] D1: Closing the panel mid-run never stops the run; the launcher pill enters live-progress (current humanized beat label + determinate ring when step total known, else indeterminate); completion toast (result headline + View → opens the PANEL to that thread); ignored toast withdraws.
- [ ] D2: Two launcher signals: quiet dot = unseen results; numbered badge = count of waiting asks; both clear on view/settle. Nothing auto-opens or auto-folds, ever (G1 law — test it).
- [ ] D3: N1 strip: "Waiting on you · N" docked above composer on every thread while asks pending; expands in place to shell cards; clears when empty.
- [ ] D4: Gates green + GIF: ask → close panel mid-run → pill progresses → toast → reopen shows record; and the badge/strip settle flow. To `evidence/lane-d/`.

### Lane E: `v4-display-hint` (spec §5)
**Files:** Modify `packages/apps/src/generation/prompts/brain.ts` (+ plan schema where the plan dialect lives), `packages/harnesses/src/render-seam.ts` (hint passthrough on the view part), `packages/ui/src/chrome/thread/parts.tsx` + `split-view.tsx` (auto-open on `display:"stage"` at build START; Back-to-chat unchanged; inline keeps Expand); Test: plan-dialect unit + split-open test.

- [ ] E1: Plan dialect gains optional `display: "inline" | "stage"`; brain prompt instructs: stage for multi-section builds the user asked to build, inline for small answer-shaped views; default inline. Validator accepts absent.
- [ ] E2: Seam forwards the hint on the `data-vendo-view` part; ThreadAppCard triggers `split.feature(appId)` when hint=stage and split not already open — only for NEW apps in the live turn (never on restore), user's Back-to-chat is sticky for the turn.
- [ ] E3: Gates green + 2 GIFs (small ask inline; "build my money HQ" auto-stages with skeleton assembling) to `evidence/lane-e/`.

### Lane F: `center` (spec §10, §12, §14; strangers §13 = simply no cross-links)
**Files:** Rewrite `packages/ui/src/chrome/vendo-page.tsx` (X1 shell); Create `chrome/center/{rail,home,apps-page,automations-page}.tsx` + mobile styles; Modify demo-bank workspace route only if props change; Test: `center.test.tsx` + Playwright mobile viewport run.

- [ ] F1: In-page rail (NO brand row, NO user row — page-inside-host-app law): New chat · Apps · Automations · "Needs you" section (only while non-empty, numbered badge) · chats grouped Today/Previous (running rows pulse; title = first user line).
- [ ] F2: Home: greeting · personalized suggestion ROWS (host-provided suggestions render as rows with icons; never chips) · live app shelf (real `AppFrame` minis, inert, scaled) · composer. Cold start = CS2 ghost tiles from host starter prompts; ghosts retire after first app exists; Apps/Automations pages get the honest empty lines.
- [ ] F3: Apps page (tile grid, tap→open app in column, "ask below to build a new one") and Automations page (shell cards: schedule · last-run receipt · Pause/Resume) replacing the five tabs; Activity/Accounts move under a quiet "···" row at rail bottom (existing panels, unchanged behavior).
- [ ] F4: Mobile P1 ≤ breakpoint: compact in-page header (Assistant · chats-sheet · apps · automations · new), slide-in history sheet, stacked home; works inside a host page (no fixed-viewport assumptions).
- [ ] F5: Gates green + GIFs: desktop walk (home→build→apps→automations→needs-you settle) and 390px mobile walk, to `evidence/lane-f/`; fleet preview links for both.

### Lane G: `reference-and-gates` (audit "no designed reference"; wave-3 "nothing we gate on could see this")
**Files:** Modify `packages/ui/gallery/main.tsx` (+ capture script); triage `packages/ui/e2e` Playwright suite; Modify `docs/archive/contracts/08-ui.md`; evidence pipeline helper.

- [ ] G1: Gallery gains a CARDS section — every card kind × states (pending/settled/declined/ceremony) × degraded-data cases (empty schema, nested args, slug names, failed logo) — rendered through the REAL components; `capture-gallery` emits PNGs per case.
- [ ] G2: Playwright UI suite: fix the pre-existing failures or quarantine them EXPLICITLY, then add a smoke pack (thread beats, approve in thread+queue, pill progress, center home) and wire it into `pnpm test` (or a `test:ui` turbo target in the root gate) so appearance drift is gate-visible.
- [ ] G3: Amend `docs/archive/contracts/08-ui.md`: C1 supersession (beats in transcript), card shell contract, pill states, center = VendoPage v2 (X1), S1 recipe note; changelog entries dated 2026-08-03.
- [ ] G4: A tiny `scripts/capture-evidence.mjs` (Playwright video → gif via ffmpeg) all lanes use; document in the plan dir.

---

## Wave 3 — integration (conductor + checker)

- [ ] I1: Merge lanes into `redesign/ui-s1` (diff shared files against fresh branch before each merge — pilot lesson 4); resolve `chrome-css.ts` appended sections into their proper places.
- [ ] I2: ONE continuous E2E as a real user on demo-bank (Yousef's Vendo account creds via `secret`): cold start → ghost tile → first build (beats→collapse, hairline calm) → pin → close mid-run → pill → toast → center home → apps/automations pages → approve a transfer in queue AND thread → fault-injected failure turn. Recorded as the wave GIF.
- [ ] I3: Independent checker (Codex, sees plan+code only) hunts: logic errors, wasteful renders, missing null/error paths, a11y (roles/focus/reduced-motion), the degraded-data matrix. Rounds until clean.
- [ ] I4: Simplify gate — cut to minimum meeting the checklist, suite stays green.
- [ ] I5: Final PR `redesign/ui-s1` → `rebuild/cutover`; AI-reviewer triage batched in one push; evidence index committed.

## Frozen done-means checklist (driving session flips items, only with proof)

1. Beats live + collapse ("Did N things · Xs") in a real demo-bank turn — GIF.
2. Build state animates EXACTLY one element (hairline): computed-style assertion + GIF.
3. Composer byte-identical in behavior (queue/stop/attach regression tests pass).
4. Close-mid-run: run continues, pill narrates with ring, toast → panel deep-link — GIF.
5. Dot vs numbered badge distinct; N1 strip counts, expands, clears — GIF.
6. V4: small ask inline / big build auto-stages at build start; Back-to-chat sticky — 2 GIFs.
7. S1 recipe: zero backdrop-filter; borders derived ≤8% fg alpha; shadow only on floaters; warm-host theme renders warm (theme-swap screenshot pair).
8. Center: X1 shell, no brand/user rows, ghost cold start, Apps/Automations doors, mobile P1 at 390px — 2 GIFs.
9. Cards: one shell across thread/queue/sheet/activities/voice/embeds; in-thread $47.50 formats; no raw slug+JSON on any end-user surface; policy banner gone from end-user surfaces; logos always fall back — gallery PNGs + tests.
10. Failure: ✕ beat + agent prose only; zero failure components — fault-injection GIF.
11. Root gate green INCLUDING the new UI smoke pack.
12. Evidence folder complete; fleet preview links posted for demo-bank + gallery.
