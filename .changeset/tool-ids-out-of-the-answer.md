---
"@vendoai/core": patch
"@vendoai/harnesses": patch
---

fix: keep internal tool identifiers and run-on sentences out of the answer a user reads.

`modelToolDescription` dropped the human label whenever a host authored no `title` (or the listing's title had fallen back to the tool's own name), so on a host whose `.vendo/tools.json` carries descriptions but no titles the identifier was the only proper noun the model held — and it printed `host_getClient`, `host_listJobs` and `host_getRevenueByMonth` in a live answer, on a host whose own design rules forbid showing an internal id. The label now falls back down the same ladder the render layer already walks (Vendo's own title table, then the prettified id), so the beat on screen and the model's vocabulary say the same words instead of the screen saying "Get client" while the model has nothing but `host_getClient`. Nothing about the CALL name changes.

`vendo()` also dropped the model's own text-block boundaries, and the wire opens a fresh transcript part only when a tool call is mirrored — so two adjacent blocks ran together mid-sentence ("…exposed here.No matching tool exists…"). A block boundary now travels as a paragraph break.
