---
"@vendoai/apps": minor
"@vendoai/core": minor
"@vendoai/store": minor
"@vendoai/ui": minor
"@vendoai/vendo": minor
---

Remove the native in-client remix execution and the remix review/approval flow (breaking: removes InClientMount, InClientVenue, ReviewStanding, apps.inClient.*, apps.review.reviewer, and the `review` prop on Remixable). Instant sandboxed remix is unchanged.
