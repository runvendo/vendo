# Connect dock auto-catalog

Approved 2026-07-19. The connect dock should advertise everything the host
chose to make connectable, without hand-wiring a UI list.

## Behavior matrix

| Host passes | Dock shows |
| --- | --- |
| `connectors={[...]}` (non-empty array) | Exactly those toolkits. No fetch. Unchanged. |
| `connectors={[]}` | Nothing. No fetch. The explicit off switch. |
| omitted + `composioConnector({ apps: [...] })` | The `apps` list, via one catalog fetch on mount. |
| omitted + `composioConnector({})` (no `apps`) | Every toolkit with an enabled auth config in the host's Composio project. |
| omitted + no connectors configured | Nothing (catalog returns empty). One cheap fetch. |

Decisions locked with Yousef:
- "All" means **auth-configured toolkits**, not Composio's full 1,000+ catalog —
  nothing in the dock may dead-end at `initiate`.
- Auto is the **default** (omitted prop fetches), not an explicit `"auto"` opt-in.

## Pieces

- **Actions connector**: optional `listConnectable()` on the connector
  interface returning `{ toolkit, label? }[]`. Composio implementation returns
  `config.apps` verbatim when set; otherwise pages `GET /api/v3/auth_configs`
  and returns the distinct enabled toolkits. In-process cache (~5 min TTL) so
  thread mounts don't hammer Composio.
- **Wire**: additive `GET /api/vendo/connections/catalog` →
  `{ available: [{ toolkit, connector, label? }] }`, aggregated across
  configured connectors, `[]` when none. Same principal resolution as the
  other connection routes. Existing endpoints unchanged.
- **UI**: `client.connections.catalog()`; `connectors` prop `undefined` =
  auto (fetch once, dock renders only if non-empty), `[]` = disabled, array =
  explicit. Names via `toolkitDisplayName` unless the catalog carries a label;
  logos via the Composio CDN (`toolkitLogoUrl`).
- **Cloud**: the catalog method rides the existing connections adapter seam.
  The cloud broker returns its own catalog when the cloud service ships the
  endpoint; until then the cloud posture serves an empty catalog (documented,
  not silent).
- **Docs**: a short "the dock advertises your connector's apps automatically"
  paragraph in `docs/connected-accounts.md`.

## Plan

1. Actions: `listConnectable` interface + Composio impl + tests (apps branch,
   auth-configs branch, cache).
2. Vendo: catalog wire endpoint + service plumbing + tests (0/1/2 connectors,
   cloud posture).
3. UI: client method, context auto semantics, dock fetch-or-explicit, tests.
4. Docs + full gate (`build`, `test`, `typecheck`, `lint`) + real-browser
   screenshot of the auto dock + PR (rides with the Composio CDN logo change).

Out of scope: cloud-service catalog endpoint (separate repo), auto-creating
auth configs, per-user catalog filtering.
