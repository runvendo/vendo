# Served apps (layer 3, experimental)

A graduated app's machine can serve a real web app on the non-`/fn` paths of
its `$PORT`. The host then embeds the machine's public URL as the app surface
instead of rendering a tree. This is layer 3 of the execution model: the tree
is gone, the box owns the surface.

Layer 3 ships fully built but disabled. Enable it per project:

```ts
createVendo({ apps: { experimentalServedApps: true } });
```

Both venues serve layer-3 URLs: a BYO sandbox (`E2B_API_KEY`) on the
provider's own hosts, and the Vendo Cloud sandbox on single-label
`m-<id>.vendo.run` ingress hosts.

With the flag off (the default), three things refuse with a typed
`VendoError("not-implemented")` naming the flag: layer-3 generation, the 2-to-3
surface flip, and `open()` on an app whose surface is already served.

## How an app reaches layer 3

The escalation judge is the same one that drives graduation 1-to-2. An
instruction whose UI needs exceed the tree (a full web app, drag-and-drop,
kanban, whiteboard, rich text) routes to the in-box agent with the served-app
contract: build the app, serve `GET /` as the entry page, keep `/fn` endpoints
working beside it, and curl your own pages until they answer.

The tree keeps serving through the whole build. The document flips to
`ui: "http"` only after the box reports a served app and the host verifies the
served root itself (`GET /` answers 200 `text/html`). A failed build or a
failed check leaves the tree surface live.

## Serving and embedding

`open()` on a served app wakes the machine (wake-on-open, about a second from
a snapshot) and returns `{ kind: "http", url }`, where `url` is the sandbox
provider's public ingress for the app's `$PORT`. The `@vendoai/ui` surface
component embeds it in a sandboxed iframe (`allow-scripts allow-forms`, plus
`allow-same-origin` only for a genuinely cross-origin URL). A served app is a
guest, not a native: it holds no host authority, and host-API access rides the
same `/fn` and callback seams as layer 2.

The machine sleeps again after the idle timeout. The next `open()` wakes it;
the wake latency is the loading state.

While the embed is open, user activity keeps the machine awake: the surface
component pings `POST /apps/:id/machine/ping` (host-proxied, one cheap HEAD
through the machine) at most once per interval while the user is active, which
re-arms the idle timer and slides the provider TTL. A ping that finds the
machine asleep answers `{ state: "woke" }`: the machine is awake again but the
embedded URL is stale, so the surface shows the resuming state and re-opens
for the fresh URL. One re-open per detection; there is no reconnect daemon.

The served URL is not stable across wakes: a resume boots a fresh provider
machine with a new id, so every wake mints a new public ingress URL. Treat
the URL from `open()` as valid for the current wake only. Never bookmark it,
store it in app data, or hand it to another user; the app surface is always
reached through `open()`.

## Theming handoff

The host theme rides the served URL as a `vendoTheme` query parameter: the
JSON theme tokens (`colors`, `typography`, `radius`, `density`, `motion`) from
the host's `.vendo/theme.json`. The served app MAY read it to match the host
brand and should ignore it when absent:

```js
const theme = JSON.parse(new URLSearchParams(location.search).get("vendoTheme") ?? "null");
if (theme) document.body.style.background = theme.colors.background;
```

There is no deeper bridge. A host that wants live theme switching can postMessage
into the iframe itself; the box agent is told the same convention.
