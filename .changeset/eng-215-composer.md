---
"@vendoai/ui": minor
---

Composer upgrades (ENG-215): the message textarea now autogrows with its content
(caps at max-height, then scrolls); typing is never blocked while a turn streams;
a message sent mid-turn visibly queues and auto-sends the moment the turn
completes (Stop stays the explicit interrupt). Adds Edit on the last user turn
(refills the composer and drops the turn so re-sending amends rather than
duplicates) and Regenerate on the last assistant turn. Fixes the focus dump to
`<body>` that used to break Escape and the overlay focus trap when the composer
disabled mid-turn. `useVendoThread` now exposes `setMessages` for headless parity.
