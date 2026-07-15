import { VendoError, type Principal } from "@vendoai/core";
import type { Connector, ConnectorAccount, ConnectorConnections } from "@vendoai/actions";

/** Subjects the runtime mints for machine principals (automations webhook
 * triggers today; the reserved `vendo:` namespace going forward). A synthetic
 * subject must never accrue human connected accounts — and it has no browser
 * to complete an OAuth redirect anyway. */
const SYNTHETIC_SUBJECT_PREFIXES = ["webhook:", "vendo:"];

export interface InitiateOptions {
  connector?: string;
  toolkit: string;
  callbackUrl?: string;
}

export interface InitiatedConnection {
  id: string;
  connector: string;
  redirectUrl: string;
}

/** 04-actions §3 (block-actions design §B) — the umbrella's per-principal
 * connected-accounts surface. Composio is the sole broker; two postures:
 *   - "byo": the host's own connector (its Composio key) carries connections;
 *   - "cloud": with VENDO_API_KEY and no BYO capability, connections ride the
 *     Vendo Cloud broker endpoint using Vendo's Composio credentials — cloud
 *     users bring zero keys. A BYO connector always wins when both are
 *     present, because connections must live where the connector executes.
 * Subject scoping IS the security model: every call passes exactly the
 * resolved principal's subject; no caller-supplied subject exists on the wire. */
export interface ConnectionsService {
  posture: "byo" | "cloud" | false;
  list(principal: Principal): Promise<ConnectorAccount[]>;
  initiate(principal: Principal, options: InitiateOptions): Promise<InitiatedConnection>;
  status(principal: Principal, connector: string, connectionId: string): Promise<ConnectorAccount | null>;
  disconnect(principal: Principal, connector: string, connectionId: string): Promise<void>;
}

function guardInitiatePrincipal(principal: Principal): void {
  if (principal.ephemeral === true) {
    throw new VendoError("blocked", "connecting external accounts requires a signed-in user; sign in first");
  }
  if (SYNTHETIC_SUBJECT_PREFIXES.some((prefix) => principal.subject.startsWith(prefix))) {
    throw new VendoError("validation", "reserved synthetic subjects cannot hold connected accounts");
  }
}

function guardCallbackUrl(callbackUrl: string | undefined): void {
  if (callbackUrl === undefined) return;
  let parsed: URL;
  try {
    parsed = new URL(callbackUrl);
  } catch {
    throw new VendoError("validation", "callbackUrl must be an absolute http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VendoError("validation", "callbackUrl must be an absolute http(s) URL");
  }
}

function byoService(brokers: Array<{ name: string; connections: ConnectorConnections }>): ConnectionsService {
  function broker(name?: string): { name: string; connections: ConnectorConnections } {
    if (name === undefined) return brokers[0]!;
    const found = brokers.find((candidate) => candidate.name === name);
    if (!found) throw new VendoError("not-found", `no connector named ${name} supports connections`);
    return found;
  }

  return {
    posture: "byo",
    async list(principal) {
      const lists = await Promise.all(brokers.map((candidate) => candidate.connections.list(principal.subject)));
      return lists.flat();
    },
    async initiate(principal, options) {
      guardInitiatePrincipal(principal);
      guardCallbackUrl(options.callbackUrl);
      const target = broker(options.connector);
      const initiated = await target.connections.initiate(principal.subject, options.toolkit, {
        ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }),
      });
      return { ...initiated, connector: target.name };
    },
    async status(principal, connector, connectionId) {
      return broker(connector).connections.status(principal.subject, connectionId);
    },
    async disconnect(principal, connector, connectionId) {
      await broker(connector).connections.disconnect(principal.subject, connectionId);
    },
  };
}

interface CloudOptions {
  apiKey: string;
  baseUrl: string;
  fetch: typeof fetch;
}

/** The OSS side of the zero-key cloud seam: same surface, brokered by the
 * Vendo Cloud console (which holds Vendo's Composio credentials). The console
 * implementation is out of scope here; this defines the wire it must serve. */
function cloudService(options: CloudOptions): ConnectionsService {
  const base = options.baseUrl.replace(/\/$/, "");

  async function cloudFetch(path: string, init?: RequestInit): Promise<unknown> {
    const response = await options.fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: "application/json",
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      // Non-JSON bodies fall through to the status check below.
    }
    if (!response.ok) {
      const error = (payload as { error?: { message?: unknown } }).error;
      const message = typeof error?.message === "string"
        ? error.message
        : `Vendo Cloud connections request failed with ${response.status}`;
      throw new VendoError(response.status === 402 ? "cloud-required" : "validation", message);
    }
    return payload;
  }

  const subjectQuery = (principal: Principal): string => `subject=${encodeURIComponent(principal.subject)}`;

  return {
    posture: "cloud",
    async list(principal) {
      const payload = await cloudFetch(`/v1/connections?${subjectQuery(principal)}`) as { connections?: unknown };
      return Array.isArray(payload.connections) ? (payload.connections as ConnectorAccount[]) : [];
    },
    async initiate(principal, options) {
      guardInitiatePrincipal(principal);
      guardCallbackUrl(options.callbackUrl);
      const payload = await cloudFetch("/v1/connections/initiate", {
        method: "POST",
        body: JSON.stringify({
          subject: principal.subject,
          toolkit: options.toolkit,
          ...(options.connector === undefined ? {} : { connector: options.connector }),
          ...(options.callbackUrl === undefined ? {} : { callbackUrl: options.callbackUrl }),
        }),
      }) as { id?: unknown; connector?: unknown; redirectUrl?: unknown };
      if (typeof payload.id !== "string" || typeof payload.redirectUrl !== "string") {
        throw new VendoError("validation", "Vendo Cloud connect initiation returned no redirect URL");
      }
      return {
        id: payload.id,
        connector: typeof payload.connector === "string" ? payload.connector : "composio",
        redirectUrl: payload.redirectUrl,
      };
    },
    async status(principal, connector, connectionId) {
      const payload = await cloudFetch(
        `/v1/connections/${encodeURIComponent(connectionId)}?${subjectQuery(principal)}&connector=${encodeURIComponent(connector)}`,
      ) as { connection?: unknown };
      return (payload.connection as ConnectorAccount | undefined) ?? null;
    },
    async disconnect(principal, connector, connectionId) {
      await cloudFetch(
        `/v1/connections/${encodeURIComponent(connectionId)}?${subjectQuery(principal)}&connector=${encodeURIComponent(connector)}`,
        { method: "DELETE" },
      );
    },
  };
}

/** The no-broker posture: listing is honestly empty (the panel renders an
 * empty state), any mutation explains what to configure. */
function unconfiguredService(): ConnectionsService {
  const refuse = (): never => {
    throw new VendoError(
      "not-implemented",
      "connected accounts are not configured: pass a Composio connector (composioConnector) to createVendo({ connectors }) or set VENDO_API_KEY for the Vendo Cloud broker",
    );
  };
  return {
    posture: false,
    list: async () => [],
    initiate: async () => refuse(),
    status: async () => refuse(),
    disconnect: async () => refuse(),
  };
}

export function createConnections(options: {
  connectors: Connector[];
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
}): ConnectionsService {
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);
  const brokers = options.connectors
    .filter((connector): connector is Connector & { connections: ConnectorConnections } =>
      connector.connections !== undefined)
    .map((connector) => ({ name: connector.name, connections: connector.connections }));
  if (brokers.length > 0) return byoService(brokers);

  const apiKey = env.VENDO_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return cloudService({
      apiKey,
      baseUrl: env.VENDO_CLOUD_URL ?? "https://console.vendo.run",
      fetch: options.fetch ?? globalThis.fetch,
    });
  }

  return unconfiguredService();
}
