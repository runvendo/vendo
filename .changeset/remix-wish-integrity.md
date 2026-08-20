---
"@vendoai/core": patch
"@vendoai/apps": patch
"@vendoai/vendo": patch
---

A remix's wish list records what the person GOT, and a follow-up edit changes the
port instead of replacing it.

One follow-up ask on Maple was refused three times and left four entries on
`seed.wishes` — a list every Update replays in order, so one ask became four
edits the person never made. The front door recorded the ask whether or not the
change landed, which is right for `memory.asks` (the next editor wants to read
"asked for X, then asked for X again, narrower") and wrong for the replay list
beside it. `AppsRuntime.remember` now takes `landed`, and only a change that
reached the screen becomes a wish. The ask itself is still recorded either way,
the list is still ordered and never trimmed, and an inapplicable wish still lands
on `seed.unapplied` and is still said out loud.

The fourth attempt then abandoned the ported source and rewrote the app out of
the host's catalog, losing the first wish's edit. The port reaches the model
through `startingSource`, which was filled from the CHECKOUT — and the checkout
only ever fills an EMPTY workspace. So once the first edit's save had landed a
file, every later edit of that remix arrived with no code at all in front of it
(the loop has no file hand and cannot read the workspace itself), and an ask with
nothing to change is answered out of the catalog. The stored screen is now read
for every edit of a remix, not only the first; it is still never written over a
file a save left behind. A port that genuinely cannot take an edit now fails
through the one channel there is, rather than succeeding as a different app.
