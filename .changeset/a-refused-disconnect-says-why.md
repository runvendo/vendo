---
"@vendoai/ui": patch
---

A refused disconnect in the connected-accounts panel says what to do about it.

`ConnectedAccountsPanel` caught the wire's refusal and threw the reason away, so every
failed disconnect read the same: "it is still connected. Try again in a moment." A lapsed
session (`blocked`) and a policy refusal (`forbidden`) never clear on their own, so that
sentence sent the person back to the same wall for as long as they were willing to click.
The panel now maps those two codes the way `connectRefusalCopy` already maps the connect
side — "Sign in first, then disconnect Gmail." and "You don't have access to disconnect
Gmail here." — and keeps the retry sentence for everything that genuinely is a wobble. The
wire's own message still never reaches the person.
