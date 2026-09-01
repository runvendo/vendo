---
"@vendoai/vendo": patch
---

The sync footer's "what moved" line now reports judgment tallies (hardened
fields, inferred schemas, applied and queued loosenings) instead of collapsing
every judged run into a single opaque "judged" fragment. A judged run that
found nothing to change now says `0 findings`, so it reads distinctly from a
keyless, structural-only run — which still omits the fragment entirely.
