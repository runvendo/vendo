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
  the caller's own scope, so the account is already gone and the person's intent is a fact.

The wire's own message still never reaches the person.

A severed row also stops depending on the list read that follows it. `useResource` keeps
its last good page when a refresh fails, so a 503 on that read used to put the row straight
back wearing a Connected chip, with nothing said — a disconnect that looked like a button
doing nothing. That was true of every successful sever, not just the already-gone case.
The panel now drops the row on the wire's word — and never permanently: a list read the
server actually answers that still carries the account overrules the sever and brings the
row back, since `not-found` also covers a missing *connector* rather than a missing account
and the client cannot tell those apart. A failed read still changes nothing.
