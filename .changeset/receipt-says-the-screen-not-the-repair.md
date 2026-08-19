---
"@vendoai/vendo": patch
---

The screen receipt describes the SCREEN again, not the repair round. A repair
round is a conversation with the reviewer: the loop is handed a finding and
answers it, so the words it ends on are "Fixed the double count" — about a
defect the person never saw. Those were the words the receipt's `say` carried,
and `vendo_make`'s caller speaks `say` verbatim, so a screen that took a repair
round announced itself to the person with its own repair log.

`say` is now taken from before the verdict on both routes to a round: the
closing save that carries the findings back and repairs inside the same drive,
and the run that ended unjudged and gets a repair drive of its own. The screen's
title still comes from the repair, because a title is read off the saved
document rather than composed by the model.
