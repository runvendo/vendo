/**
 * /api/vendo/integrations — the REAL Composio connect flow behind the
 * in-memory connections store that gates agent ingestion.
 *
 *  - GET (no query) returns the catalog with live `connected` flags.
 *  - GET ?status&id=<toolkit>&account=<connectedAccountId> polls Composio; when
 *    ACTIVE it ALSO marks the toolkit connected (the agent gains it next turn,
 *    because the agent cache keys on the connected set).
 *  - POST { id, action: "connect" } fast-paths an already-authorized toolkit,
 *    else begins OAuth and returns { redirectUrl, connectedAccountId }.
 *  - POST { id, action: "disconnect" } flips the store off (store only).
 *
 * CAPABILITY-ADDITIVE: without COMPOSIO_API_KEY the endpoints stay up but
 * inert — GET reports `enabled: false` with an empty catalog (the client
 * hides the integrations UI), POST answers 503. No errors, no crashes.
 */
import { createComposioClient, type ComposioClient } from "@vendoai/runtime";
import { resolvePrincipal } from "./guard.js";
import type { VendoHandlerOptions } from "./options.js";
import type { ConnectionsStore } from "./connections.js";

export { DEFAULT_INTEGRATION_CATALOG } from "./catalog.js";
export { createConnectionsStore } from "./connections.js";
export type { ConnectionsStore } from "./connections.js";

export interface IntegrationsDeps {
  store: ConnectionsStore;
  enabled: boolean;
  options: VendoHandlerOptions;
  /** Injectable for tests; defaults to a lazily-built real client. */
  client?: ComposioClient;
}

// Lazily-constructed singleton: never touches the network until first use.
let realClient: ComposioClient | undefined;
function getClient(deps: IntegrationsDeps): ComposioClient {
  if (deps.client) return deps.client;
  if (!realClient) {
    realClient = createComposioClient({ apiKey: process.env["COMPOSIO_API_KEY"] });
  }
  return realClient;
}

/** True iff `id` is a toolkit in the handler's catalog. */
async function isKnownToolkit(deps: IntegrationsDeps, id: string): Promise<boolean> {
  return (await deps.store.list()).some((i) => i.id === id);
}

export async function handleIntegrationsGet(req: Request, deps: IntegrationsDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  if (!deps.enabled) return Response.json({ enabled: false, integrations: [] });

  const url = new URL(req.url);
  if (url.searchParams.has("status")) {
    const id = url.searchParams.get("id") ?? "";
    const account = url.searchParams.get("account") ?? "";
    if (!id || !account) {
      return Response.json({ error: "status requires id and account" }, { status: 400 });
    }
    if (!(await isKnownToolkit(deps, id))) {
      return Response.json({ error: "unknown integration id" }, { status: 400 });
    }
    try {
      const status = await getClient(deps).connectionStatus(account);
      // The store is the agent gate. Marking a toolkit connected requires TWO
      // facts: the polled account is ACTIVE *and* this user genuinely has an
      // active connection for THIS toolkit — otherwise a caller could pass any
      // active account id against any toolkit id and flip it on without OAuth.
      if (status === "active" && (await getClient(deps).hasActiveConnection(guard.principal.userId, id))) {
        // This IS where the OAuth flow lands a successful connection — the
        // client polls with the same `account` (connectedAccountId) it got
        // back from the POST /connect leg, so this is the one place the
        // in-memory/durable store can tie a Composio connected-account id to
        // a toolkit for webhook routing (findByConnectedAccount). Subsumes
        // connect(id)'s effect (marks the toolkit connected too).
        await deps.store.setConnectedAccount(id, account);
        return Response.json({ status: "active" as const });
      }
      // The client-facing status must reflect what actually happened. A raw
      // "active" we did NOT record (anti-spoof case: foreign/other-toolkit
      // account) must not read as connected — downgrade it to "pending" so the
      // client keeps polling instead of showing connected with no toolkit.
      return Response.json({ status: status === "active" ? ("pending" as const) : status });
    } catch {
      return Response.json({ status: "failed" as const });
    }
  }
  return Response.json({ enabled: true, integrations: await deps.store.list() });
}

export async function handleIntegrationsPost(req: Request, deps: IntegrationsDeps): Promise<Response> {
  const guard = await resolvePrincipal(req, deps.options);
  if (!guard.ok) return guard.response;
  if (!deps.enabled) {
    return Response.json(
      { error: "integrations are disabled — set COMPOSIO_API_KEY to enable them" },
      { status: 503 },
    );
  }

  let body: { id?: unknown; action?: unknown };
  try {
    body = (await req.json()) as { id?: unknown; action?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return Response.json({ error: "missing integration id" }, { status: 400 });
  // Validate against the catalog BEFORE touching Composio, so a caller can't
  // spend the server's Composio key initiating OAuth for arbitrary slugs.
  if (!(await isKnownToolkit(deps, id))) {
    return Response.json({ error: "unknown integration id" }, { status: 400 });
  }
  const userId = guard.principal.userId;

  if (body.action === "connect") {
    try {
      // Fast path: already authorized in Composio → mark connected immediately.
      // NOTE: `hasActiveConnection` doesn't hand back a connectedAccountId, so
      // this path can't call `setConnectedAccount` — only the status-poll
      // branch above captures one. A user who reaches "connected" purely via
      // this fast path won't have a Composio webhook route until they go
      // through a fresh authorize()+poll cycle (documented gap, not fixed
      // here — see docs/persistence-and-deploy.md when it lands).
      if (await getClient(deps).hasActiveConnection(userId, id)) {
        await deps.store.connect(id);
        return Response.json({ connected: true });
      }
      const { redirectUrl, connectedAccountId } = await getClient(deps).authorize(userId, id);
      return Response.json({ connected: false, redirectUrl, connectedAccountId });
    } catch (err) {
      // Log the detail server-side; don't echo the SDK's message (it can carry
      // internal URLs/ids) back to the caller.
      console.error("[vendo] integrations connect failed:", err);
      return Response.json({ error: "connect failed" }, { status: 400 });
    }
  }

  if (body.action === "disconnect") {
    await deps.store.disconnect(id);
    return Response.json({ enabled: true, integrations: await deps.store.list() });
  }

  return Response.json({ error: "action must be 'connect' or 'disconnect'" }, { status: 400 });
}
