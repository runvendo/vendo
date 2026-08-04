# The wave E2E, RE-CAPTURED (integration v2)

`../integration/wave.gif` is now a record of behavior that no longer ships. The
three post-check rounds changed the surface materially:

- the thread's error banner lost its Retry (rulings 16 + 18)
- the stage hint's one-shot ledger moved from the card into the split (H9)
- the activity row, the consent ladder and the money rule were rewritten
  (C2, C5, H6, H14)
- the center grew keyboard, focus and landmark contracts (H10, H12, H17, H18)
- app tiles became inert and boot only when scrolled to (H11, H16)

So the run was redone, end to end, as ONE continuous session.

## How it was captured

| | |
| --- | --- |
| host | `examples/demo-bank` (Maple), **`next build` + `next start -p 3230`** |
| browser | headless Chromium (Playwright), 1320×860 @2×, video recorded |
| model | real `ANTHROPIC_API_KEY`, real generation, real guarded host tools |
| driver | `wave-e2e-v2.mjs` |
| clip | `wave-v2.gif` (+ `wave-v2.webm`), stills `01`…`25` |

**A PRODUCTION BUILD, not `next dev`.** Round A proved this matters: several of
this wave's fixes move developer text behind `developmentMode()`, and a
dev-served surface renders the *developer* half by design (`activity-ledger.tsx`
prints `event.inputPreview` verbatim in dev; the turn-error path keeps the raw
exception in dev). A `next dev` capture would photograph the opposite of the
claim. Proven in-run rather than asserted — `serverHeaders` reads
`{"xPoweredBy": null, "devOverlay": false}`.

Consequences of that choice, both good:

- nothing is suppressed for the camera. The v1 run had to hide Next's
  `<nextjs-portal>` dev badge with an injected stylesheet; a production build
  ships none, so this run injects no cosmetic CSS at all.
- no debug panel, no test recorder, no scripted transport in any frame.

The key never persisted: read one name at a time
(`infisical secrets get ANTHROPIC_API_KEY --plain`) by redirect into
`examples/demo-bank/.env.local`, which is `.gitignore`d and was deleted by the
runner's exit trap (`cleanup: .env.local removed (gone)` in the run log).

Cold start is real: `POST /maple/api/demo/reset` runs the store's erase cascade
over the demo subjects (threads, generated apps, pins, grants) before the browser
opens.

## What the run proves

| # | Claim | Frame | Machine-read fact |
|---|---|---|---|
| 0 | The surface is production, not dev | all | `xPoweredBy: null`, `devOverlay: false` |
| 1 | Cold start into the real host | `01`, `02` | real Maple login (form POST → Auth.js JWE), demo reset before load |
| 2 | Beats tick in the transcript | `03` | `beatsWorking: ["Get spending insights"]` |
| 3 | **A build animates EXACTLY one thing** | `04` | `buildCalmSamples: {first: ["fl-boot-hairline"], union: ["fl-boot-hairline"], samples: 9}` — an in-page rAF sampler, 9 frames, union of everything that ever looped while `[data-state="building"]` was up |
| 4 | The build narrates ONCE (§8 D1) | `04` | `beatsDuringBuild: ["Get spending insights"]` — no second "Build an app…" beat beside the card's own bar |
| 5 | The card lands, staged at build start (V4) | `05` | `card: true`, `staged: true` |
| 6 | **H9 — Back-to-chat is FINAL** | `06` | `h9BackToChatFinal: true`: after Collapse workspace, `[data-vendo-expanded]` is gone and the hint does not re-open it. The ledger is in the split, so the collapse cannot re-arm it |
| 7 | The settled turn folds into one row, reopens in place | `07`, `08` | `summaryText: "Did 3 things · 19.6s"`, `beatsAtSettle: []` (folded away) |
| 8 | Close mid-ask → the run continues, the pill narrates | `09`, `10` | `pillProgress: true`, `pillLabel: "Working…"` |
| 9 | The completion toast deep-links back to the record | `11`, `12` | `toastHead: "Here are your top three merchants this month, tallied from your transactions:"` — the agent's real prose, then View reopens the panel |
| 10 | **§15 / rulings 16+18 — a dead turn offers NO Retry in the thread** | `13` | `failureCopy: "Something went wrong and the response didn't finish."`, `retryButtonsInThread: 0`, `errorBannerButtons: 0`, `regenerate: true` |
| 11 | **One card shell; in-thread money formats; consumer voice** | `14` | `rows: [["Amount","$47.50"],["Recipient name","Acme Utilities"],["Memo","July water bill"]]`, eyebrow `"Needs your approval"`, line `"Sends $47.50 to Acme Utilities — now, as you."`, plus an `Irreversible` chip (ruling 15 — a destructive ask never shares a word with a write) |
| 12 | No model instruction, no wire slug, reaches the reader | `14` | `approvalLeaks: {integerCents: false, rawSlug: false}` — the descriptor's "Amounts are integer cents…" sentence is nowhere on the card |
| 13 | **A money ask goes pending → settled** | `14`→`15`→`16`, `17` | `morphToast: true`, `approvalSettled: true`, `approvalOutcome: "I'll send that now — $47.50 to Acme Utilities…Send moneyDone —"`; `17` shows the settled record in prose: `Done — $47.50 sent to Acme Utilities, memo "July water bill."` |
| 14 | **✕ + prose, and zero failure components** | `17` | `refusal.beats: ["Send money — you declined it"]`, `crossGlyphs: 4`, `retryButtonsInThread: 0`, and the agent's own line: `"No problem — I've cancelled it. Nothing moved, and the declined request is recorded in Activity."` — §15's copy law (what happened · nothing changed · where it went) with only Copy/Regenerate beside it |
| 15 | **H6 — the card and its queue row read from ONE ladder** | `18`, `21` | in-thread card `"Sends $75.00 to Maple Savings — now, as you."` · center queue row `"Sends $75.00 to Maple Savings — now, as you."` — identical, on two different surfaces, from one live ask |
| 16 | §4 — the numbered badge counts what is waiting | `19` | `launcherBadge: "1"` (`badgeAppeared: true`) |
| 17 | §12 — the center is a PAGE inside the host app | `20`, `23`, `24` | `brandRow: false`, `userRow: false`, doors `["New chat","Apps","Automations"]`; Maple's own header and sidebar surround it |
| 18 | **H10 — one tab stop, one named panel** | `20` | `tabStops: 1`, `panelIds: ["vendo-center-panel"]` (every tab points at the one panel that exists), `panelNamed: "New chat"` |
| 19 | **H12 — exactly one `<main>` landmark** | `20` | `mainLandmarks: 1` |
| 20 | **H18 — arrows move focus, they do not activate** | `22` | after ArrowDown ×2 / ArrowUp / End / Home: `selectedBefore: "New chat"` → `selectedAfter: "New chat"`; the open conversation and its draft survive |
| 21 | **H11 — a tile's live preview is inert** | `23` | `tiles: {tiles: 5, inert: 5, ariaHidden: 0}` — `inert` on every one, `aria-hidden` on none (the old lie the keyboard could walk into) |
| 22 | **H17 — a navigation carries focus with it** | `25` | `h17FocusAfterNav: {tag: "BUTTON", label: "Send money", isBody: false}` — focus landed on the thing navigated to, not on `<body>` |
| 23 | §4 — the center says what needs you | `25` | `needsYou: true`, `needsYouText: "Send money"` |

`ok: true`, driver exit 0.

## Which segments were live, and which were faulted

Everything above is a live turn against the real model and the real guarded host
tools, with two exceptions, both stated rather than hidden:

- **Frame `13` (the dead turn)** is faulted at the NETWORK layer: Playwright
  aborts the real `POST /maple/api/vendo/threads`. The stream death is real and
  the surface reacting to it is the shipped one in production mode; only the
  *cause* is injected. Nothing is scripted in the UI, and no director /
  `ScriptedTransport` mode is used anywhere in this run.
- **Frame `17`'s ✕** comes from a REFUSED step, which is deterministic (click
  Deny), not from an engine build failure. A denied step carries the same ✕ glyph
  as a failed one — `build-beat.tsx:449-452` renders one SVG path for both, muted
  for a decline and danger-coloured for an error — and §15's prose law is the
  same. `errorBeats: 0` / `dangerCrosses: 0` record honestly that no genuinely
  FAILED step occurred on this take: a host-tool fault is server-side and so
  unreachable from the browser, and an engine build failure is not summonable on
  demand (v1 caught one from the honesty gate on 2 of 3 takes). The failed-build
  variant is pinned instead by the browser smoke pack's "a failed build ends the
  turn in ✕ and prose, and offers no component to poke" — the assertion this
  integration un-quarantined, now passing.

## Two honest loose ends

- `stillBuildingAtSettle: {hairlines: 1, buildingBars: 0}`. One
  `.fl-boot-hairline` NODE is still in the DOM once the turn has settled, with
  zero elements in the `building` state. This is a node count, not an animation
  measurement — the rAF sampler only ran while a build was in flight — so it is
  recorded, not explained. Worth one look before the PR lands.
- Frames `09` and `10` are byte-identical (`md5 9bd19efd…`). The launcher's
  progress ring was already live at the instant the panel closed, so the
  wait-for-the-ring step returned immediately and photographed the same moment
  twice. The pill's narration is carried by the machine fact (`pillLabel:
  "Working…"`) and by `11`, not by a difference between those two frames.

## Earlier takes

Three takes were recorded. Takes 1 and 2 are not in the tree; each covered the
checklist only partly, and the reason is written down because it is the useful
part:

- **take 1** got build-calm and the dead turn but read the launcher badge one
  poll cycle too early (`launcherBadge: ""`), and its ✕ probe looked for
  `.fl-beat--failed`, a class that exists nowhere — so it reported zero crosses
  for the wrong reason. That is exactly ruling 17a's blind fixture, in my own
  driver.
- **take 2** fixed the badge (waits for it) and the ✕ selectors, but a fast build
  opened and closed the `building` window between two 400 ms driver polls
  (`buildCalm: false`), and the ask parked by the refusal segment blocked the
  composer so the dead-turn segment never sent (`turnFailed: false`).
- **take 3** — this one — replaced driver polling with an in-page rAF sampler
  (which cannot miss the window) and moved the dead-turn segment ahead of any
  parked approval. One continuous run, every claim above inside it.
