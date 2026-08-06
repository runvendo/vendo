---
"@vendoai/vendo": minor
"@vendoai/core": minor
"@vendoai/ui": minor
---

Connect asks first: a `request_connection` tool and a connect card that owns the whole answer.

The agent can now ASK for a connection instead of spending a call it already knows
will be refused. `request_connection` (toolkit + one plain sentence) mints exactly the
`connect-required` outcome a refused service call produces, so the card the user sees
is the same card — nothing new on the wire. The tool is projected only where the
deployment can actually connect the toolkit, and refuses one it cannot rather than
raising a button that can never succeed.

The card itself now opens its sign-in window *inside the click*, before any `await`:
Safari and Firefox judge a popup by call-stack provenance, and the old order (initiate,
then open) is precisely the shape they block. The window opens centered and blank, is
navigated when the redirect URL arrives, and is closed from the opener once the account
goes active. A window the browser blocked anyway is no longer a dead end — the same
poll keeps running behind an "Open sign-in in a new tab" link.

The card also says what connecting grants, in plain words rather than OAuth scope
strings, and offers "Not now" — which leaves a one-line Skipped record that still
re-offers Connect, and tells the agent so it can adapt.
