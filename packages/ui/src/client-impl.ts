/** Fetch/SSE bindings for the public wire route table (08-ui §2, 09-vendo §3). */
import { VendoError, type VendoErrorCode } from "@vendoai/core";
import type { VendoClient, VendoClientConfig } from "./client.js";
import type { ConnectableToolkit, ConnectionAccount } from "./wire-types.js";

const KNOWN_ERROR_CODES = new Set<VendoErrorCode>([
  "validation",
  "blocked",
  "not-implemented",
  "sandbox-unavailable",
  "cloud-required",
  "not-found",
  "conflict",
]);

function route(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function idPath(id: string): string {
  return encodeURIComponent(id);
}

async function throwWireError(response: Response): Promise<never> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await response.text());
  } catch {
    parsed = undefined;
  }

  const error =
    typeof parsed === "object" && parsed !== null && "error" in parsed
      ? (parsed as { error?: unknown }).error
      : undefined;
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "validation";
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : response.statusText || `HTTP ${response.status}`;

  if (KNOWN_ERROR_CODES.has(code as VendoErrorCode)) {
    throw new VendoError(code as VendoErrorCode, message);
  }

  // 01-core §15: unknown codes are generic errors, but keep the wire code available.
  throw Object.assign(new Error(message), { code });
}

async function ensureOk(response: Response): Promise<Response> {
  if (!response.ok) await throwWireError(response);
  return response;
}

/** 08-ui §2 */
export function createVendoClient(config: VendoClientConfig): VendoClient {
  const baseUrl = config.baseUrl ?? "/api/vendo";
  const headers = { ...(config.headers ?? {}) };

  async function request(path: string, init?: RequestInit): Promise<Response> {
    return ensureOk(
      await fetch(route(baseUrl, path), {
        ...init,
        headers: {
          ...headers,
          ...(init?.headers as Record<string, string> | undefined),
        },
      }),
    );
  }

  async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await request(path, init);
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async function json<T>(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown = {}): Promise<T> {
    return readJson<T>(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  return {
    baseUrl,
    headers,
    threads: {
      stream: async input =>
        request("/threads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }),
      list: () => readJson("/threads"),
      get: id => readJson(`/threads/${idPath(id)}`),
      delete: id => json(`/threads/${idPath(id)}`, "DELETE"),
    },
    approvals: {
      pending: () => readJson("/approvals"),
      decide: (ids, decision) => json("/approvals/decide", "POST", { ids: Array.isArray(ids) ? ids : [ids], decision }),
    },
    grants: {
      list: () => readJson("/grants"),
      revoke: id => json(`/grants/${idPath(id)}`, "DELETE"),
    },
    connections: {
      list: async () => (await readJson<{ connections: ConnectionAccount[] }>("/connections")).connections,
      catalog: async () => (await readJson<{ available: ConnectableToolkit[] }>("/connections/catalog")).available,
      initiate: input => json("/connections/initiate", "POST", input),
      status: (id, connector) =>
        readJson(`/connections/${idPath(id)}${connector === undefined ? "" : `?connector=${encodeURIComponent(connector)}`}`),
      disconnect: (id, connector) =>
        json(`/connections/${idPath(id)}${connector === undefined ? "" : `?connector=${encodeURIComponent(connector)}`}`, "DELETE"),
    },
    apps: {
      list: () => readJson("/apps"),
      create: input => json("/apps", "POST", input),
      get: id => readJson(`/apps/${idPath(id)}`),
      delete: id => json(`/apps/${idPath(id)}`, "DELETE"),
      open: id => readJson(`/apps/${idPath(id)}/open`),
      call: (id, ref, args) => json(`/apps/${idPath(id)}/call`, "POST", { ref, args }),
      edit: (id, instruction) => json(`/apps/${idPath(id)}/edit`, "POST", { instruction }),
      history: id => readJson(`/apps/${idPath(id)}/history`),
      undo: id => json(`/apps/${idPath(id)}/history`, "POST", { op: "undo" }),
      exportApp: async id => new Uint8Array(await (await request(`/apps/${idPath(id)}/export`)).arrayBuffer()),
      importApp: bytes =>
        readJson("/apps/import", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes as BodyInit,
        }),
      fork: id => json(`/apps/${idPath(id)}/fork`, "POST"),
      shipDiff: id => readJson(`/apps/${idPath(id)}/ship-diff`),
      pinDrift: id => readJson(`/apps/${idPath(id)}/pin-drift`),
      rebasePin: (id, slot) => json(`/apps/${idPath(id)}/rebase-pin`, "POST", { slot }),
      pingMachine: id => json(`/apps/${idPath(id)}/machine/ping`, "POST"),
    },
    automations: {
      list: () => readJson("/automations"),
      enable: id => json(`/automations/${idPath(id)}/enable`, "POST"),
      disable: id => json(`/automations/${idPath(id)}/disable`, "POST"),
      dryRun: id => json(`/automations/${idPath(id)}/dry-run`, "POST"),
    },
    runs: {
      list: filter => {
        const params = new URLSearchParams();
        if (filter?.appId !== undefined) params.set("appId", filter.appId);
        if (filter?.status !== undefined) params.set("status", filter.status);
        if (filter?.cursor !== undefined) params.set("cursor", filter.cursor);
        const query = params.size > 0 ? `?${params.toString()}` : "";
        return readJson(`/runs${query}`);
      },
      get: id => readJson(`/runs/${idPath(id)}`),
      stop: id => json(`/runs/${idPath(id)}/stop`, "POST"),
    },
    activity: {
      list: params => {
        const query = new URLSearchParams();
        if (params?.cursor !== undefined) query.set("cursor", params.cursor);
        if (params?.limit !== undefined) query.set("limit", String(params.limit));
        return readJson(`/activity${query.size > 0 ? `?${query.toString()}` : ""}`);
      },
    },
    status: () => readJson("/status"),
  };
}
