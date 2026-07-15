# Connected accounts

External connectors (Gmail, Slack, GitHub, … via Composio) execute as the
signed-in user, not as one shared bot account. Each user connects their own
account once; every later call rides that connection.

Composio is the sole broker — Vendo builds no OAuth flows of its own. A
connection is a Composio connected account whose `entityId` is the Vendo
principal subject, so isolation is structural: every read, initiate, and
disconnect is scoped to exactly one subject.

## Setup

BYO key (OSS): pass the Composio connector to `createVendo`.

```ts
import { composioConnector } from "@vendoai/actions";

createVendo({
  // ...
  connectors: [composioConnector({ apiKey: process.env.COMPOSIO_API_KEY!, apps: ["gmail"] })],
});
```

Vendo Cloud: set `VENDO_API_KEY` and bring no Composio key — connection
endpoints ride the Vendo Cloud broker with Vendo's Composio credentials. A BYO
connector always wins over the cloud broker when both are configured, because
connections must live where the connector executes. `GET /api/vendo/status`
reports the active posture under `blocks.connections`: `"byo"`, `"cloud"`, or
`false`.

## The in-flow connect card

When a connector call needs a connection the user doesn't have, the tool
returns a typed `connect-required` outcome instead of an opaque error. The
shipped `VendoThread` renders an inline connect card (the approvals pattern):
Connect opens the broker's hosted OAuth page, the card polls until the
connection is active, and the thread retries the call.

## The settings panel

`ConnectedAccountsPanel` (a tab in `VendoPage` chrome, exported from
`@vendoai/ui/chrome`) lists the user's connected accounts and disconnects
them. Disconnect severs the broker-side account.

## Wire endpoints

All per-principal — the wire passes exactly the resolved principal's subject;
no caller-supplied subject exists.

- `GET /api/vendo/connections` — list
- `POST /api/vendo/connections/initiate` `{ toolkit, connector?, callbackUrl? }` — returns `{ id, connector, redirectUrl }`
- `GET /api/vendo/connections/:id?connector=` — status (poll while connecting)
- `DELETE /api/vendo/connections/:id?connector=` — disconnect

Anonymous (ephemeral) visitors cannot initiate — connecting an external
account requires a signed-in user. Synthetic subjects (webhook principals)
are refused.

## Risk labels

Composio tools carry curated risk instead of a blanket `write`:

1. Composio metadata hints (`destructiveHint`, `readOnlyHint` tags) where present;
2. slug patterns — destructive verbs (`DELETE`, `REMOVE`, `DESTROY`, …)
   anywhere mark destructive; leading read verbs (`GET`, `LIST`, `FETCH`, …)
   mark read;
3. conservative `write` default.

`.vendo/overrides.json` still wins.

## MCP connector credentials

`mcpConnector({ headers })` accepts either shared static headers (the simple
default) or an async per-principal resolver:

```ts
mcpConnector({
  url: "https://mcp.example.com",
  headers: async ({ principal, presence, grant }) => ({
    authorization: `Bearer ${await tokenFor(principal)}`,
  }),
});
```

With a resolver, each subject gets its own MCP session; descriptor listing
resolves without a principal. Every connector execution is audited with its
account identity (connector, toolkit, entityId, shared vs per-principal
credential) in the tool-call event's detail.
