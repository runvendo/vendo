---
"@vendoai/ui": patch
---

The workbench feed keeps the last 20 turns, and an update costs only the turn it
landed in

The store held every turn a dev session had ever seen, and rebuilt the whole
snapshot on each part — copying every retained turn's parts array. A long
session therefore grew without bound, and each diagnostic got slower as history
piled up behind it.

Turns are now capped at 20, the oldest first-seen dropped as newer ones arrive,
and a published part replaces only its own turn's entry: every other turn keeps
the exact object and array the previous snapshot handed out, so a reader that
compares identities sees precisely which turn is news. Ordering, `seq` sorting,
and the fresh outer snapshot per part are unchanged.
