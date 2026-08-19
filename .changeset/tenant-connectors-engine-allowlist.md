---
"@vendoai/core": patch
---

`vendo_tenant_connectors` joins the engine allowlist. The collection tenant
connectors write their registrations to (`packages/vendo/src/tenant-connectors.ts`)
was never added to `ENGINE_COLLECTION_REGISTRY`, so a deployment on a
Cloud-hosted store — the posture a Cloud host gets by leaving the store slot
unset — had its first registration refused with `collection
"vendo_tenant_connectors" is not an engine collection`, which left `register`,
`list`, `test` and every tenant's own tools dead on a live deployment while the
suite stayed green: every tenant-connector test composes a local store, and a
local store has no allowlist in front of it. Exactly the miss the text channel's
three collections shipped with. The name is added with the `file:line` comment
each entry in that list carries, `ENGINE_ALLOWLIST_VERSION` moves 5 → 6 as that
constant's contract requires, and a new seam test drives
`createTenantConnectors` through `hostedStore`, `hostedStoreOps` and the fake
console — which serves the same gate as the live door precisely so a fake cannot
bless a collection production refuses. If your BYO store pins the allowlist
version, bump it.
