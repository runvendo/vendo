import { VendoError, type Principal } from "@vendoai/core";
import type { Connector, ConnectorAccount, ConnectorConnections } from "@vendoai/actions";
import { consoleSender, raiseCloudError } from "./cloud-console.js";

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

/** One row of the connect dock's auto catalog: a toolkit a user could finish
 * connecting, tagged with the broker that would carry it. */
export interface ConnectableToolkit {
  toolkit: string;
  connector: string;
  label?: string;
  /** One-line capability blurb — feeds the OSS discovery index. */
  description?: string;
}

/** 04-actions §3 (block-actions design §B) — the umbrella's per-principal
 * connected-accounts surface. Which implementation composes is decided at the
 * seam, never in here (adapter rule — see selectConnections in server.ts).
 * Composio is the sole broker; two postures:
 *   - "byo": the host's own connector (its Composio key) carries connections;
 *   - "cloud": connections ride the Vendo Cloud broker endpoint using Vendo's
 *     Composio credentials — cloud users bring zero keys.
 * Subject scoping IS the security model: every call passes exactly the
 * resolved principal's subject; no caller-supplied subject exists on the wire. */
export interface ConnectionsService {
  posture: "byo" | "cloud" | false;
  list(principal: Principal): Promise<ConnectorAccount[]>;
  initiate(principal: Principal, options: InitiateOptions): Promise<InitiatedConnection>;
  status(principal: Principal, connector: string, connectionId: string): Promise<ConnectorAccount | null>;
  disconnect(principal: Principal, connector: string, connectionId: string): Promise<void>;
  /** The connect dock's auto catalog — host-level (every principal sees the
   * same rows), unlike everything above. Empty when nothing is connectable. */
  catalog(): Promise<ConnectableToolkit[]>;
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

/** The BYO capability predicate — the same test the composition seam selects
 * on and byoConnections builds brokers from. */
export function hasConnections(
  connector: Connector,
): connector is Connector & { connections: ConnectorConnections } {
  return connector.connections !== undefined;
}

/** The BYO adapter: connections live on the host's own connector(s), because
 * they must live where the connector executes. Built from every passed
 * connector that carries a connections capability. */
export function byoConnections(connectors: Connector[]): ConnectionsService {
  const brokers = connectors
    .filter(hasConnections)
    .map((connector) => ({ name: connector.name, connections: connector.connections }));
  if (brokers.length === 0) {
    throw new VendoError("validation", "byoConnections requires at least one connector with a connections capability");
  }

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
    async catalog() {
      const catalogs = await Promise.all(brokers.map(async (candidate) => {
        const entries = await candidate.connections.listConnectable?.() ?? [];
        return entries.map((entry) => ({ ...entry, connector: candidate.name }));
      }));
      return catalogs.flat();
    },
  };
}

export interface CloudConnectionsOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  /** Catalog scoping, mirroring cloudTools' `apps`: a host that scopes its
   * cloud tools explicitly passes the same list here so the connect dock
   * never advertises a toolkit the agent cannot invoke. Unset = everything
   * the console's catalog serves. */
  apps?: string[];
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, hosted-store's) — a hung console
   * must never wedge the connections surface. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The shared console error table (cloud-console.ts): 401/402 → cloud-required
 * (fix your Cloud standing), wire-legal envelope codes forward as VendoErrors,
 * and anything else (unknown codes, 5xx, non-JSON bodies) rides a plain Error
 * with the server's code attached — never a "validation" error blaming the
 * caller for the console misbehaving (hosted-store's posture). */
const raiseConnectionsError = (response: Response): Promise<never> =>
  raiseCloudError(response, "connections", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });

/** The Cloud adapter — the OSS side of the zero-key cloud seam: same surface,
 * brokered by the Vendo Cloud console (which holds Vendo's Composio
 * credentials). The console implementation is out of scope here; this defines
 * the wire it must serve. */
export function cloudConnections(options: CloudConnectionsOptions): ConnectionsService {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  // The key-authed console sender (cloud-console.ts): Bearer auth + deployment
  // identity (the console meters usage from real traffic) + per-request abort
  // timeout, raising through the shared error table on any non-2xx.
  const send = consoleSender({
    base,
    mountPath: "",
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl,
    raise: raiseConnectionsError,
  });

  async function cloudFetch(path: string, init?: RequestInit): Promise<unknown> {
    const response = await send(path, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
        ...init?.headers,
      },
    });
    try {
      return await response.json();
    } catch {
      // A 2xx that isn't JSON means a misdeployed Cloud base (an SPA host or
      // reverse proxy that 200s unknown paths with text/html). Fail loudly —
      // hosted-store's malformed-200 posture — instead of reading as an empty
      // connections list (or a not-found account) forever.
      throw new VendoError(
        "validation",
        `Vendo Cloud connections returned a non-JSON ${response.status} response — check VENDO_CLOUD_URL`,
      );
    }
  }

  const subjectQuery = (principal: Principal): string => `subject=${encodeURIComponent(principal.subject)}`;

  return {
    posture: "cloud",
    async list(principal) {
      const payload = await cloudFetch(`/api/v1/connections?${subjectQuery(principal)}`) as { connections?: unknown };
      if (!Array.isArray(payload.connections)) {
        // A 2xx without the envelope is the SERVICE misbehaving — never
        // indistinguishable from a genuinely empty connections panel.
        throw new VendoError("validation", "Vendo Cloud connections returned an invalid list response (no connections array)");
      }
      return payload.connections as ConnectorAccount[];
    },
    async initiate(principal, options) {
      guardInitiatePrincipal(principal);
      guardCallbackUrl(options.callbackUrl);
      const payload = await cloudFetch("/api/v1/connections/initiate", {
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
        `/api/v1/connections/${encodeURIComponent(connectionId)}?${subjectQuery(principal)}&connector=${encodeURIComponent(connector)}`,
      ) as { connection?: unknown };
      return (payload.connection as ConnectorAccount | undefined) ?? null;
    },
    async disconnect(principal, connector, connectionId) {
      await cloudFetch(
        `/api/v1/connections/${encodeURIComponent(connectionId)}?${subjectQuery(principal)}&connector=${encodeURIComponent(connector)}`,
        { method: "DELETE" },
      );
    },
    async catalog() {
      const payload = await cloudFetch("/api/v1/connections/catalog") as { available?: unknown };
      const available = Array.isArray(payload.available) ? (payload.available as ConnectableToolkit[]) : [];
      return options.apps === undefined
        ? available
        : available.filter((entry) => options.apps!.includes(entry.toolkit));
    },
  };
}

/** The no-broker fallback adapter: listing is honestly empty (the panel
 * renders an empty state), any mutation explains what to configure. */
export function unconfiguredConnections(): ConnectionsService {
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
    catalog: async () => [],
  };
}
