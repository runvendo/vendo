---
"@vendoai/ui": patch
---

A refused disconnect in the connected-accounts panel says what to do about it.

`ConnectedAccountsPanel` caught the wire's refusal and threw the reason away, so every
failed disconnect read the same: "it is still connected. Try again in a moment." The panel
reads the code now, and that retry sentence is reserved for the faults that actually clear
on their own (broker 5xx, timeouts, a dropped request):

- `blocked` → "Sign in first, then disconnect Gmail."
- `forbidden` → "You don't have access to disconnect Gmail here."
- `not-implemented` / `cloud-required` → "Disconnecting Gmail isn't set up here — there's
  nothing you can do from this screen."
- `not-found` → **not an error at all.** The broker answers not-found for any id outside
  the caller's own scope, so the account is already gone and the person's intent is a
  fact; the panel re-reads the list and the stale row leaves, exactly as a real sever ends.

The wire's own message still never reaches the person.
