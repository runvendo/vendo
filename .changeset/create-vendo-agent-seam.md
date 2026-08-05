---
"@vendoai/vendo": minor
"@vendoai/agents": minor
"@vendoai/apps": minor
---

`createVendo({ agent })` accepts a whole `@vendoai/agents` agent, and the sandbox
ladder has one implementation.

`createVendo`'s `agent` key is now a union: either the chat-context knobs it has
always taken (now exported as `AgentOptions`) or the value `agent()` from
`@vendoai/agents` returned. Handed an agent, the deployment adopts what that
agent already composed — its harness, its store and blob adapter, its
egress-skinned sandbox, and its `instructions` — so the embed's turns run on the
same brain, the same transcript and the same box as `session.stream`. Passing any
of `harness`, `store`, `files` or `sandbox` alongside an agent is a boot error
naming each conflict, instead of one side silently losing.

The guard and the host tool surface stay the deployment's: the embed's choke
point carries org policy and app-tool risk grading, and its tools come from
`.vendo/tools.json`. The agent's own guard and tools keep serving its `session()`
calls.

`VENDO_API_KEY` now fills an `agent()` sandbox slot the host left unset with the
managed Cloud pool — importing `@vendoai/vendo` registers the Cloud rung the
standalone runtime leaves open. An explicitly passed adapter still wins. The
Cloud STORE rung stays open pending the tenant-store design, so an unset `store:`
with only a Vendo key still refuses and names `store: postgres(url)`.

`@vendoai/apps` gains the `./sandbox-ladder` subpath: `selectSandbox(configured,
cloudRung)` is now the ONE implementation of the adapter rule's sandbox ladder
(explicit → `E2B_API_KEY` → the Cloud rung → nothing), shared by the umbrella and
the standalone agent runtime. `SandboxVenue` moves there with it.
