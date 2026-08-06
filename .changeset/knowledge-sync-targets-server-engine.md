---
"@vendoai/vendo": minor
---

`vendo knowledge sync` now pushes to the engine the composed server would
read, and says which one it chose.

Engine selection mirrors `selectKnowledge` (server.ts), restricted to what a
CLI can know: an injected adapter wins; otherwise `VENDO_API_KEY` means Vendo
Cloud (honouring `VENDO_CLOUD_URL`), so sync pushes over the existing
`vendo/knowledge-wire@1` /upsert + /remove; with no key it stays on today's
local lexical engine over `.vendo/data`.

Before, a Cloud-keyed project synced its docs into a *local* store while its
agent searched Cloud — the docs went somewhere the server never read, and
nothing said so. Both the plan line and the result line now name the target:

```
Synced: 3 upserted, 1 removed, 128 unchanged → Vendo Cloud (console.vendo.run)
Synced: 3 upserted, 1 removed, 128 unchanged → local store (.vendo/data)
```

No new flags or config: the key you already have decides, the same way it
decides for the server.
