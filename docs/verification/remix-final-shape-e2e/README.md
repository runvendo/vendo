# Remix final shape — W1e continuous E2E proof (2026-08-03)

ONE continuous real-browser session (Playwright Chromium, `run-e2e.mjs`)
against **demo-bank (Maple)** running the production build — `next build`
+ `next start` on `http://localhost:4310/maple` — with a fresh local PGlite
store, real Auth.js sign-in, real BYO Anthropic inference, and the review
seam composed via `MAPLE_DEV_SEAMS=1` (the seam is dev-composition scoped;
`next start` runs production NODE_ENV, so the demo opts in explicitly — see
`examples/demo-bank/src/vendo/server.ts`). Run on a branch rebased onto
main WITH #740 (WFIX2 round-2 hardening), so the review steps exercise the
hardened model: **Yousef remixes; Mia — asserted as Maple's host reviewer
via `apps.review.reviewer` — approves and rejects from her own signed-in
seat; an owner can never approve their own remix.**

The jailed fork rides a `sandbox="allow-scripts"` iframe (opaque origin), so
the driver can't read inside it: in-jail facts are asserted at the DOM
boundary (the iframe element), server-side over the wire (the fork's stored
document), and visually via the screenshots below. Machine-written verdicts
live in `results.json`.

**Review seam note:** the checklist offers "console screen if reachable
locally, else the wire seam directly — state which". The W1d review console
lives in the vendo-web repo (Cloud); it is not runnable against this local
store, so approval and rejection were driven through the REAL wire seam
directly from the reviewer's session: `GET /apps/review-queue` (which
returned the ship-diff review artifact), the documented
`POST /dev/inclient-approval` door, and `POST /apps/:id/reject-review`.

**Engine #631 note:** generation did NOT block — step d's app generated
through the real path (no records-door seeding needed). The guard parked
change-making tool calls for user approval mid-turn; the driver clicked
Approve exactly as a user would (part of the step-a timeline).

## Steps → screenshots → verdicts

| Step | What happened | Screenshot | Verdict |
|---|---|---|---|
| — | Signed in; home renders with both wrappers (✦ seeds); Mia signs in on a second seat as the reviewer | `00-signed-in-home.png` | PASS |
| a1 | ✦ remix on NetWorthCard → deterministic fork (`POST /apps/fork-pin`, no model call) mounted **sandboxed, in place** at the wrapper boundary, rendering the page's real data; server recorded `pins: [{slot: NetWorthView, base: sha256:52ce29c1…}]` | `a1-fork-jailed-in-place.png` | **PASS** |
| a2 | ✦ popover → **Open in panel** → composer prefilled `Update my NetWorthView remix (app …): ` → instructed a label change → guard parked the edit tool, approved → the fork's stored source carries the change and the jailed fork re-rendered: the card now reads **"Net worth (remixed)"** | `a2-fork-edited-via-panel.png` | **PASS** |
| a3 | ✦ popover → **Revert to original** → fork app deleted server-side, jail unmounted, host original back | `a3-reverted-original-back.png` | **PASS** |
| a4 | ✦ remix again → fresh fork mounts jailed in place | `a4-remixed-again.png` | **PASS** |
| b1 | ✦ remix on the review component (QuickActionsView, `<Remixable review>`) → popover reports **"Waiting for review"**; the original strip keeps rendering; **no jailed frame ever** | `b1-sent-for-review-original-stays.png` | **PASS** |
| b2 | REAL wire seam, from **Mia's reviewer seat**: `GET /apps/review-queue` listed the fork with its ship-diff (`b2-review-queue.json`); `POST /dev/inclient-approval` approved that exact version (round-2 hardening: the owner cannot self-approve; Mia holds the `apps.review.reviewer` assertion) | — | **PASS** |
| b3 | After approval the fork mounts **NATIVE in place** — `data-vendo-inclient-mount`, its 5 action buttons in real host DOM, zero iframes; popover: "Approved by mia@maple.com — runs in the page" | `b3-approved-native-in-place.png` | **PASS** |
| c | Reverted, remixed again (pending), Mia rejected via `POST /apps/:id/reject-review` with a note → the note surfaces verbatim in the ✦ panel ("Rejected — \"Keep the Maple icon tint — resubmit with brand colors.\" Edit the remix to resubmit it for review."); the original still renders, nothing mounted | `c1-rejection-note-in-panel.png` | **PASS** |
| d | Slot suggestion chip → real generation (~13s) → **Pin to dashboard** → `placements: ["home-hero"]` written on the app row (`d2-apps-after-pin.json`), **no fabricated pin**, app renders in the home-hero slot, **no drift warning anywhere** | `d1-generated-app-in-panel.png`, `d2-placed-in-home-hero-slot.png` | **PASS** |

## Cadence (demo-accounting) conversion proof

Production build at `http://localhost:4311/cadence` (autologin mode):

- `cadence-dashboard-converted.png` — dashboard pixel-faithful after the
  conversion (hero + deadline list render identically).
- `cadence-hero-remix-pill.png` — ✦ on the `<Remixable>` hero
  (MissingDocsHero, in place; the VendoSlot remains for director mode only).
- `cadence-deadline-remix-pill.png` — ✦ on the `<Remixable review>`
  deadline card (DeadlineListView).

## Bugs found by this E2E

1. **Pending-review rendered a notice card instead of the original**
   (wrapper mounted the AppFrame for any tree surface; popover mislabeled
   the state). Found and fixed in this lane; **superseded by #740 (WFIX2
   F1/F2)** on rebase — main's broader fix and tests stand, this lane's
   version was dropped.
2. **The panel edit dead-ended in "which app?".** The agent's app tools are
   all appId-keyed and no list tool exists, so the popover's bare
   `Update my X remix: ` prefill left the agent unable to resolve the fork
   (it asked the user for the app id — a polite dead end). Fixed HERE: the
   prefill now carries the app id in the visible, user-editable prompt text
   (the grounding-chip channel died with the final shape). Test updated.

## Finding (not fixed here — cross-lane)

- **The appId-less fork still mints `placements: [slot]`**
  (`packages/apps/src/runtime.ts`, "the empty-slot gesture means show the
  remix in THIS slot", asserted by `fork-pin.test.ts`). That was right when
  the gesture lived on an empty VendoSlot (W0); under the final shape the
  in-place fork "needs no placement — its location is the wrapper it
  replaced" (design doc), and the wrapper discovery reads pins only. Today
  it is harmless in both demos (no VendoSlot id collides with a wrapper slot
  name), but a host naming a slot after a wrapped component would get the
  whole fork app mounted in that slot. Left to the driving session: W0 owns
  the mint and its test.
