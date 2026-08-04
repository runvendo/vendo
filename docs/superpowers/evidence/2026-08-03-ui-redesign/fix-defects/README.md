# Fix-defects proof — the two build states the wave E2E caught wrong

The wave integration E2E
(`../integration/README.md`, §"Three defects this run found") photographed three
defects. This is the same two build states, re-captured after the fixes, on the
same surface and by the same method.

## Surface and method

- **Surface:** a LIVE `demo-bank` (Maple) — real Maple login
  (`yousef@maple.com`), real `ANTHROPIC_API_KEY` → real generation, real guarded
  host tools, real split-view workspace. `PORT=3222`, headless Chromium at
  1320×860 @2x. The server was reaped after the run.
- **Driver:** `fix-defects-proof.mjs`
  (`PORT=3222 node docs/superpowers/evidence/2026-08-03-ui-redesign/fix-defects/fix-defects-proof.mjs`).
  Nothing is scripted, stubbed or directed — no director mode, no scripted
  transport, no test recorder appears in any frame.
- **Machine facts:** read off the live DOM the way the integration README does —
  every element under `.vendo-root` whose *computed* `animationName` is set and
  whose `animationIterationCount` is not `1` is listed by class. Raw facts in
  `facts.json`; run transcript quoted below.
- The key never touched disk: read one name at a time
  (`infisical secrets get ANTHROPIC_API_KEY --plain`) straight into the dev
  server's process environment. No `.env.local` was written.
- The only thing hidden for the capture is Next's own dev-server error badge
  (`nextjs-portal`) — dev-tool chrome, never shipped.
- The `display: "stage"` hint fired on the first ask, so the mid-build frame is
  measured AFTER the expand's FLIP ghost lands. The ghost is a literal clone of
  the card (hairline included) and counting it would report the shared-element
  flight as a second build animation; it is transient chrome, not a build
  element.

## (a) MID-BUILD — one narration, one animating element

`a-midbuild-one-narration-one-animation.png` (§8 A2 + D1)

| Fact | Wave E2E (before) | This run (after) |
|---|---|---|
| beats in the transcript during the build | `["Get spending insights· 6 data", "Build an app…"]` | `["Get spending insights· 6 data"]` |
| beats belonging to the build step | `["Build an app…"]` | `[]` |
| elements animating during the build | `["fl-boot-hairline"]` | `["fl-boot-hairline"]` |
| the card bar's live label | `"Building your view…"` | `"Building your view…"` |

The build step now narrates exactly once — the card bar — with the host read
keeping its own beat beside it. Build calm is unchanged: one animating element,
the hairline.

## (b) A FAILED BUILD AT SETTLE — zero animating elements, consumer voice

`b-failed-build-settled-zero-animation.png` (§8 build calm, §15, §16 law 3) —
the whole record fits the frame, so this IS the complete thread

Both asks in this run failed the generation guard's honesty checks, so the
settled thread carries two dead builds — measured the moment the turn is over
(the composer's `Stop` unmounts).

| Fact | Wave E2E (before) | This run (after) |
|---|---|---|
| elements still animating at settle | 1 (`fl-boot-hairline`, still sweeping) | `[]` |
| `hairlines` in the DOM | `1` | `0` |
| `buildingBars` | `0` | `0` |
| app cards left | 1, stuck on the skeleton | `0` |
| forming skeletons anywhere | present (`● Building your view...`) | `0` |
| the split view's stage | stuck on the dead skeleton | `stageEmptyState: 1` — "Views you build land here." |
| beats at settle | `["Build an app — couldn't finish", "Couldn't build the app"]` | same, ×2 (two failed asks) |
| the prose the user reads | ``the `value` expression is a declarative string that the DataTable does not evaluate … amount / sum(spending.data.amount)`` | `"I couldn't finish building that view — nothing was changed. Ask again and I'll try a different approach."` |
| code-shaped patterns in that prose | many | `[]` |

Zero failure furniture grew: the only affordances on the settled turn are the
shipped `Copy` and `Regenerate` (visible in the frame), exactly as §15 requires.

### The developer's sentence still exists — for developers

`server-log-developer-sentences.txt` is the tail of the same run's server log.
While the user read "I couldn't finish building that view", the operator got the
whole thing, e.g.

```
[vendo] app build failed (app_5d2983f4-…): This app wasn't created, because it
didn't pass the checks that keep an app honest: The Spending Breakdown table was
never built — the Grid contains only the literal error text … instead of the
requested table with Category, Amount, and Share columns derived from
spending.data
  - The binding reads `budget.dining_allocated_cents` … the actual field names
    returned by `host_getBudgets` are unknown …
```

That is the split the fix is: same information, two audiences, one of them not
the end user.

## Found while proving this, NOT fixed here

`buildFailureReason` (`packages/apps/src/runtime.ts`) classifies by substring
scan over the concatenated findings, and `QUOTA_SIGNAL` includes `payment` —
so a finding that lists Maple's host tools (`host_listScheduledPayments`)
makes an ordinary generation-validation failure persist as
`reason: "quota exhausted", retryable: false`. Observed live in the first
capture run of this session: the user was told "try again a little later" for a
build that would have failed identically, and the embed surface would have
hidden its retry button. This is why the user-facing sentence is ONE sentence
for every class rather than branching on that label. The classifier defect is
reported, not fixed — it belongs to `packages/apps` and deserves its own change
with its own tests.
