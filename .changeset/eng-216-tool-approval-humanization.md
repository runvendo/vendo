---
"@vendoai/ui": minor
---

Tool & approval humanization (ENG-216): add an additive, UI-side host-metadata
seam (`VendoProvider` `tools` prop — friendly labels, descriptions, and custom
arg summarizers per tool) with a formatting fallback that prettifies raw tool
ids and formats args into readable summaries. Tool chips no longer show the raw
slug or the ai-SDK lifecycle string, consecutive identical tool chips collapse
into one entry with a count, and the in-thread `ApprovalCard` no longer
fabricates or displays a context byline (the queue path keeps its real
server-provided `ctx`). No contract or wire changes.
