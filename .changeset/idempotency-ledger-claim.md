---
"@vendoai/core": patch
"@vendoai/store": patch
---

IdempotencyLedger.claim reserves a key before the mutation runs. A different body is refused before it writes, while same-body contenders wait for and replay the owner's answer.
