---
"@vendoai/ui": patch
---

Four polish passes on the chat chrome's cards.

- **An approval settles where it was asked.** The approval→notification morph is
  an AUTOMATION's ask only: a person answering their own live conversation is
  already looking at the answer, so flying the card into a corner pill narrated a
  handoff that never happened. In-thread asks carry venue `chat`, so nothing in
  the thread morphs — the venue is the rule, not a switch.
- **The shield glyph comes off every consent surface** — the modal, the
  standing-access card, the resolved card — matching the in-chat approval card,
  which has been iconless for a while.
- **The conversation blurs under a generated view in flight.** An opaque embed
  card travelling over a razor-sharp transcript read as two competing layers
  instead of one thing moving; the rail softens for the flight and clears as it
  lands, and stays sharp under `prefers-reduced-motion`, where a blur that cannot
  fade is just a flash.
- **The app card arrives with the BUILD, not with the first view bytes.** It only
  mounted on the first `data-vendo-view` part, so the whole window between the
  ask and the first bytes rendered nothing build-specific. The card now arrives
  empty, in the place the view will fill, and stands down the moment the first
  partial lands.
