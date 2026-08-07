---
"@vendoai/agents": minor
---

`vendoKnowledge` is no longer re-exported from `@vendoai/agents`.

`AgentConfig` and `AgentComposition` have no knowledge slot, so nothing composed
through the agents front door could use it — the umbrella's knowledge seam is
its own `createVendo({ knowledge })` key, never the agent's. Import it from
`@vendoai/knowledge`, which is where every real consumer already imports it
from. The `@vendoai/knowledge` dependency goes with it.

`session()` also stops opening the workspace twice — the first result was
discarded before the per-turn open, so this removes one database round trip per
session, including on the `{ threadId }` resume path.
