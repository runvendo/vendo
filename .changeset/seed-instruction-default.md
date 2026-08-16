---
"@vendoai/core": patch
---

Apps seeded before a remix carried its instruction load again. `appSeedSchema` made `instruction` required, so every stored `seed` written without one failed the read-side integrity check (`validateDocument`) and its app refused to open — a document that had been valid when it was written became unreadable. `instruction` now defaults to the empty string on read, so an old seed parses as the seed it always was while the field stays required for everything that writes one.
