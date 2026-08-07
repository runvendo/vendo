---
"@vendoai/guard": patch
---

Two guard fixes. `previewCheck` no longer spends the single-use approval it was only inspecting: the pipeline now knows whether the caller is committing, so a preview reports that an approved replay exists without claiming its `consumed:<id>` receipt, and the real dispatching check that follows claims it — once, atomically, exactly as before. Previously a previewed call with a stable id answered "run", burned the human's tap, and then parked a fresh approval when the real call arrived, so the call never executed. And `sweepExpiredApprovals` now queries the pending set instead of paging every approval ever decided and filtering in JS — that read ran every 60 seconds per process and grew without bound.
