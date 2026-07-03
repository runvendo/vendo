/**
 * /api/flowlet/integrations — the REAL Composio connect flow behind the
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
import { createComposioClient, type ComposioClient } from "@flowlet/runtime";
import { resolvePrincipal } from "./guard";
import type { FlowletHandlerOptions, IntegrationCatalogEntry } from "./options";

export { DEFAULT_INTEGRATION_CATALOG } from "./catalog";

export interface ConnectionsStore {
  list(): Array<IntegrationCatalogEntry & { connected: boolean }>;
  connect(id: string): void;
  disconnect(id: string): void;
  connectedToolkits(): string[];
}

/** In-memory connected-toolkit set — the single source of truth for what the
 *  agent ingests. Everything starts DISCONNECTED on boot. */
export function createConnectionsStore(catalog: IntegrationCatalogEntry[]): ConnectionsStore {
  const validIds = new Set(catalog.map((c) => c.id));
  const connected = new Set<string>();
  return {
    list: () => catalog.map((c) => ({ ...c, connected: connected.has(c.id) })),
    connect: (id) => {
      if (validIds.has(id)) connected.add(id);
    },
    disconnect: (id) => {
      connected.delete(id);
    },
    connectedToolkits: () => catalog.filter((c) => connected.has(c.id)).map((c) => c.id),
  };
}

export interface IntegrationsDeps {
  store: ConnectionsStore;
  enabled: boolean;
  options: FlowletHandlerOptions;
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
    try {
      const status = await getClient(deps).connectionStatus(account);
      // The store is the agent gate: only mark connected once Composio is ACTIVE.
      if (status === "active") deps.store.connect(id);
      return Response.json({ status });
    } catch {
      return Response.json({ status: "failed" as const });
    }
  }
  return Response.json({ enabled: true, integrations: deps.store.list() });
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
  const userId = guard.principal.userId;

  if (body.action === "connect") {
    try {
      // Fast path: already authorized in Composio → mark connected immediately.
      if (await getClient(deps).hasActiveConnection(userId, id)) {
        deps.store.connect(id);
        return Response.json({ connected: true });
      }
      const { redirectUrl, connectedAccountId } = await getClient(deps).authorize(userId, id);
      return Response.json({ connected: false, redirectUrl, connectedAccountId });
    } catch (err) {
      return Response.json(
        { error: `connect failed: ${err instanceof Error ? err.message : "unknown error"}` },
        { status: 400 },
      );
    }
  }

  if (body.action === "disconnect") {
    deps.store.disconnect(id);
    return Response.json({ enabled: true, integrations: deps.store.list() });
  }

  return Response.json({ error: "action must be 'connect' or 'disconnect'" }, { status: 400 });
}
