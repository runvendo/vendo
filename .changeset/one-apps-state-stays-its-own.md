---
"@vendoai/ui": patch
---

An app's `$state` no longer leaks into the next app rendered in its place. `TreeView` keyed its stateful body on `tree.root`, but the compiler roots every compiled app at the same synthetic `root` node, so the key never changed between two different apps: React reused the instance and app B rendered app A's `$state` (and outcomes). `TreeView`, `PayloadView` and `AppFrame` now take an optional `appId` — the identity the surrounding code already had — and key on it. Omit it and the key falls back to `tree.root` exactly as before, so no existing caller changes behavior.
