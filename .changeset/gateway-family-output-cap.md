---
"@vendoai/apps": patch
---

The vendo Cloud gateway's own model family (`vendo`, `vendo-paint`, `vendo-judge`, `vendo-extract`) joins the capability rule that already protected the Claude 5 line: sampling params are dropped and the explicit 64K output cap is set on every call. The family ids are unknown to the stock `@ai-sdk/anthropic` capability registry, which silently clamps unknown models to 4096 max_tokens — a screen agent's generated document truncated mid-wire, nothing painted, no app row landed, and every row-scoped verb (validate, commitSource, schedule) answered not-found. Field-hit on a Cloud-keyed deployment where every escalated build and automation arm failed with "has no row to hold its source".
