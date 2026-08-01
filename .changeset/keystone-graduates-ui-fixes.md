---
"@vendoai/ui": patch
---

Three fixes the Keystone demo build turned up.

**ConnectCard hangs on "Connecting…" under React StrictMode.** The card's
cancel ref was only ever SET (by the effect's cleanup) and never reset on
setup, so dev-mode's mount → cleanup → re-mount latched it before the user
ever clicked: `completeConnection`'s poll loop saw "cancelled" on its first
check, returned without throwing, and the card sat on the spinner forever.
It now resets on setup, exactly like its sibling `ConnectedAccountsPanel`
already did. Hosts no longer need `reactStrictMode: false` to demo a connect.

**The composer centred its own text past one line.** `.fl-composer-row` was
`align-items: flex-end`, which is right for a one-line field and wrong for
every other: a textarea's text sits at ITS top, so as the field grew the row
pushed the icons and Send DOWN while the text stayed put — the input read as
mis-centred and Send moved under the cursor mid-sentence. The row is now
top-anchored, so the field grows downward and the controls hold still. At one
line the icon's 34px box and the text's 33px line box agree, so the collapsed
composer is unchanged.

**A single failed `apps.open` skeletoned a pinned app forever.** `useApp`
recorded the error and every mounted surface kept rendering "Loading app…"
until a full page reload. The load now retries three times with backoff
(300ms, 600ms), and a load that really is dead renders a terminal state with
a "Try again" button — in `VendoSlot` and in `VendoPage`'s app pane.
