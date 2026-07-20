# Connection-scoped tool loading

Approved 2026-07-20 (approach B). Stop loading the full connector catalog into
the agent; load only what the user has connected, keep everything else
discoverable, and never seed the loadout with alphabetical junk.

## Problem

In cloud / unset-`apps` posture the connector advertises Composio's whole
enabled catalog — ~4,002 tools across 56 toolkits. Two failures follow:

1. `computeInitialLoadout` (packages/agent/src/tool-search.ts) caps the
   starting active set at 128 and, when the surface exceeds the cap, sorts by
   `(risk, name)` and takes the first 128 — pure alphabetical garbage
   (`airtable_*`, `asana_*`, `box_*`). The agent begins every turn with 128
   irrelevant tools active and reaches for them (observed live: the agent
   executed Asana/Box tools it had no business calling).
2. The connector fetches and holds all 4,002 descriptors; tool-search ranks
   over the whole pile.

Root cause is the loadout seed, not tool-search itself — but the fix should
also stop the wasteful full-catalog fetch.

## Decision (locked)

- The agent must still **discover unconnected toolkits and prompt to connect**
  from chat (the in-flow connect card). So discovery must cover the full
  connectable set even though execution is scoped to connected toolkits.
- Approach **B**, not Composio's tool-router model (**C**). C (meta-tools:
  search/execute/manage-connections, no real descriptors) is what the Composio
  plugin does and is the eventual direction, but it collapses every tool onto
  one `execute` meta-tool with one risk label, which breaks Vendo's per-tool
  approval cards. B keeps real per-tool descriptors for connected tools so
  approvals/risk labels stay intact. B's discovery index + per-turn expansion
  is also the groundwork C would need later — a stepping stone, not a
  throwaway.

## Core tension the design resolves

Tool descriptors load **once per deployment** (the registry memoizes
`connectorDescriptors`), but connections are **per-user**. "Only load
connected toolkits" therefore cannot happen at the global descriptor level; it
resolves **per turn**, where the principal is known (`ctx`). B is built around
that per-turn seam.

## Two tiers of tool knowledge

1. **Discovery index** — deployment-global, cheap. One lightweight entry per
   *connectable* toolkit: slug, display name, a one-line capability blurb.
   ~56 entries, not 4,002 schemas. Always searchable; never executable on its
   own.
2. **Live tools** — per-turn, full schemas, executable. Only the toolkits the
   current principal has an **active connection** to (usually 0–3 → tens of
   tools). Plus host tools and `vendo_*` meta-tools (always).

## Per-turn data flow

- Registry loads once: host tools + `vendo_*` meta-tools + the discovery index
  (searchable meta-entries, not executable connector tools).
- Each turn, using the principal in `ctx`:
  - ask the connections service which toolkits are connected,
  - expand those toolkits into live executable tools (schemas fetched on
    demand, per-toolkit cached),
  - seed the loadout from them + host tools. The seed is exactly the user's
    relevant tools — no alphabetical junk.
- `vendo_tools_search(intent)` searches both tiers:
  - hit on a **connected** toolkit's tool → activate it into context (today's
    behavior),
  - hit on an **unconnected** toolkit → return a "connect X to use this"
    result → the connect card fires (connect-required flow, proactively). On
    connect, that toolkit's tools become live and usable.

## Where the index text comes from

The catalog endpoint we already ship (`/connections/catalog`) gives the 56
slugs. Enrich each with a one-line description from Composio's toolkit metadata
(one cheap `/toolkits`-style call, ~56 items, cached) so search can match
"send email" → gmail. Static fallback blurbs for anything missing.

## Scope

- **OSS agent** (packages/agent): `computeInitialLoadout` seeds from connected
  toolkits instead of alphabetical top-N; tool-search consults the discovery
  index + per-turn connection state; the per-turn expansion seam.
- **OSS connectors** (packages/actions, packages/vendo): `composioConnector`
  and `cloudTools` split into "discovery index" + "per-turn live tools for
  connected toolkits" — identical behavior BYO and cloud.
- **Console** (vendo-web): the catalog endpoint (or a sibling) returns toolkit
  descriptions for the index; the existing `/tools?toolkits=` fetch already
  supports on-demand per-toolkit loading.

## What stays unchanged

- Per-tool risk labels and the approval/consent cards — B's whole reason for
  existing over C. The guard sees the same real, individually-labeled tools.
- The connect dock catalog and the connect-required card flow.

## Testing

- Loadout: connected toolkits seed the initial set; zero-connection user gets
  host tools + meta-tools only; never alphabetical junk.
- Search: a connected toolkit's tool activates; an unconnected toolkit surfaces
  as connect-required (drives the card); after connect, its tools load.
- Connector: `composioConnector`/`cloudTools` return the discovery index at
  load and expand only connected toolkits per turn; on-demand schema fetch is
  cached.
- Console: catalog/toolkits endpoint returns descriptions; per-toolkit tools
  fetch unchanged.
- Regression: BYO with explicit `apps` still loads exactly those; approvals
  and risk labels unchanged end-to-end.

## Out of scope / deferred

- Approach C (Composio tool-router meta-tools) — revisit once the guard is made
  argument/tool-aware at execute time. B leaves the door open.
- Trimming the 56 dashboard auth configs — orthogonal ops task.
