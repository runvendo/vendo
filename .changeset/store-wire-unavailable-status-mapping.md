---
"@vendoai/core": patch
---

`parseStoreWireError` no longer degrades a 429/5xx store-wire failure to
`not-implemented`. A dropped Postgres connection under load answered a bare
503, and the client reported "Vendo Cloud store does not support the
transcripts.appendMessages operation" — a transient dependency failure
misread as a missing capability. 429/500/502/503/504 now classify as the new
`unavailable` VendoErrorCode (retryable); 400/402/403/409 are unchanged. The
console's own `unavailable` envelope (`lib/api/respond.ts`'s
`apiServerError`) now parses as itself too, instead of failing schema
validation for carrying a code the enum didn't recognize.
