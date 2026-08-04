# Wave 3 integration — the WAVE E2E (plan I2)

One continuous run as a real user against a **live demo-bank** (real Maple
login, real `ANTHROPIC_API_KEY` → `claude-sonnet-4-6`, real generation, real
guarded host tools), headless Chromium, recorded end to end.

- driver: `wave-e2e.mjs` (`PORT=3220 node …/wave-e2e.mjs`)
- clip: `wave.gif` (+ `wave.webm`), stills `01…20`
- extra: `21-launcher-badge-verified.png`, `fault-live/*.png` (see §Fault path)

The key never touched disk: it was read one name at a time
(`infisical secrets get ANTHROPIC_API_KEY --plain`) straight into the dev
server's process environment via command substitution — no `.env.local` was
written, and none exists in the tree.

The only thing hidden for the capture is Next's own dev-server error badge
(`nextjs-portal`) — dev-tool chrome, never shipped. No test recorder, no debug
panel, and no scripted transport appears in any live frame.

## What the run proves

| # | Claim (frozen checklist) | Frame | Machine-read fact |
|---|---|---|---|
| 1 | Beats live in the transcript, fold into one row | 03, 06, 07 | `summaryText: "Did 5 things · 51.4s"`, reopen flips in place |
| 2 | The build animates EXACTLY one element | 04 | `movingDuringBuild: ["fl-boot-hairline"]` — computed-style sweep of every `.vendo-root *` with a looping animation |
| 4 | Close mid-run → run continues, pill narrates, toast deep-links | 08–11 | `pillLabel: "Working…"`, ring present, `toastHead: "Here are your three biggest merchants this month, by total spend:"`, View reopens the record |
| 5 | Numbered badge counts asks; Needs-you counts and clears | 16, 20, 21 | `launcherBadge: "1"`; `21-…` re-verified after two poll cycles: `badge "1"`, spoken `"1 waiting on you"`, wire `pending = 1`; rail shows `NEEDS YOU 2` |
| 6 | V4: a big build auto-opens the stage at build START | 05 | `staged: true` while the skeleton is still assembling |
| 8 | Center = a PAGE inside the host app | 17–20 | `brandRow: false, userRow: false`, doors `["New chat","Apps","Automations"]`, Maple's own header/sidebar surround it; live app tiles render real balances |
| 9 | One card shell; in-thread money formats; consumer voice | 12–14 | `approvalRows: [["Amount","$47.50"],["Recipient name","Acme Utilities"],["Memo","July water bill"]]`, eyebrow `"Needs your approval"`, line `"Vendo will run Send money as you."` |
| 10 | Failure = ✕ beat + prose, zero failure components | `fault-live/` | `beatsAtSettle: ["Build an app — couldn't finish","Couldn't build the app"]`, retry is Regenerate only |

**The `$47.50` row is the wave's headline fix, proven live on the surface the
defect happened on.** Before the integration wiring the in-thread ask synthesized
`inputSchema: {}` and rendered `4750 (unit not specified)`; it now reads
`$47.50` in the thread because the descriptor travels with the approval
(spec §16 law 2).

**Approval, end to end (12 → 13 → 14):** pending card → ENG-205 morph toast as
the run resumes → the ask is gone and the agent's own record lands
(`"Sending $47.50 to Acme Utilities now … Proceeding." / "Send money" / "Done"`).
Verified as a state assertion, not a screenshot guess: the ask must be absent
AND the turn must have resumed.

## Fault path — captured LIVE, not directed

No director mode was needed. Live generation failed the engine's own honesty
gate on two of the three recorded takes, so the §15 vocabulary was captured
from a real failure: `fault-live/fault-03-x-beat-and-stuck-stage.png`.

The ✕ beat stays in the record, the summary does not count the failed call, and
there are no retry buttons/chips/cards — only the shipped Regenerate. That is
spec §15 behaving exactly as designed, on real data.

Generation succeeded on 1 of 3 takes. That flakiness is **pre-existing engine
quality, not a wave regression** — the failures are the generation guard's
honesty checks rejecting the model's plan (percent column bound to a raw cent
integer; a hard-coded date range; a goal that does not exist in the data), and
nothing in this wave touches the generation engine except Lane E's optional
`display` hint field. It matches the known ~50% first-attempt rate.

## Three defects this run found (for the checker)

1. **D1 double-narration.** During a build the transcript shows BOTH a
   `Build an app…` beat and the card's own `Building your view…` bar
   (`beatsDuringBuild: ["Get spending insights· 6 data","Build an app…"]`).
   Spec §8 D1 says the build gets NO beat because the card IS the step. The
   suppression (`producedAppCard`) only fires once the `data-vendo-view` part
   exists, but Lane C registers the stage skeleton at build START — so there is
   a window where the step narrates twice. Frames 04 and `fault-02`.
2. **A failed build leaves the stage sweeping forever.** At settle after a
   failed build: `stillBuildingAtSettle: {hairlines: 1, buildingBars: 0}` —
   `data-state="building"` cleared but the hairline element survives and keeps
   animating, and the stage still shows the skeleton with
   `● Building your view...`. This breaks §8 build-calm for the settled turn.
   Frame `fault-live/fault-03-x-beat-and-stuck-stage.png`.
3. **The build-failure prose is the developer's sentence.** The
   `data-vendo-build-failed` path renders the engine's reason verbatim to an end
   user, complete with code identifiers
   (``the `value` expression is a declarative string that the DataTable does not
   evaluate``, ``amount / sum(spending.data.amount)``). Same consumer-voice class
   as the `vendo-slot.tsx` defect fixed in this wave, on a sibling path that was
   not on the ledger. Frame `fault-live/fault-03-…`.

Also observed, as flagged at wiring time: the dev log shows **two
`GET /api/vendo/approvals` per cycle** on the center page. Both surfaces now
read the one `useAttention` hook, so their COUNTS can no longer disagree, but
each mount still owns its own poller.
