/** Fetch/SSE bindings for the public wire route table (08-ui §2, 09-vendo §3). */
import { VendoError, joinPath, mountMismatchMessage, type RunId, type VendoErrorCode } from "@vendoai/core";
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
  // Build contract §9.4 — the code the fork offer renders from: the caller
  // provably SEES the app and was denied the action, so the surface can answer
  // with "…but I can make you your own" instead of a bare refusal.
  "forbidden",
]);

function idPath(id: string): string {
  return encodeURIComponent(id);
}

/** The slot list rides ONE query param, comma-separated, so each id is
 *  percent-encoded on its own BEFORE the join — otherwise a "," inside a slot
 *  id reads as the separator and the page asks for two slots that do not
 *  exist. The outer encode is the ordinary query-value escape; the route
 *  decodes each item after the split (`wire/apps.ts`). */
function slotsQuery(slots: readonly string[]): string {
  return `?slots=${encodeURIComponent(slots.map(encodeURIComponent).join(","))}`;
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

/** Browser event announced after approvals.decide lands, so EVERY consent
 *  surface sharing the page (a host's own queue, the workspace, the voice
 *  stage) resumes a thread parked on that approval — the thread chrome listens
 *  and settles its matching in-thread card. Guarded for SSR. */
export const APPROVALS_DECIDED_EVENT = "vendo:approvals-decided";

export interface ApprovalsDecidedDetail {
  ids: string[];
  approved: boolean;
  /** The grant SET the decided ids settle (automations enable() capture),
   *  when the deciding surface knows it — listeners match parked cards on
   *  set membership as well as raw ids. Strictly additive. */
  grantSetId?: string;
}

function announceApprovalsDecided(detail: ApprovalsDecidedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ApprovalsDecidedDetail>(APPROVALS_DECIDED_EVENT, { detail }));
}

/** A Vendo wire reply always speaks JSON — the host's own 404 page does not. */
function isWireEnvelope(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").includes("application/json");
}

/** The path prefix the PAGE is served under, when the browser can say — the
 *  other half of the mount-mismatch message. SSR has no location. */
function pageMount(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const segments = window.location.pathname.split("/").filter(Boolean);
  return segments.length === 0 ? "" : `/${segments[0]}`;
}

/** The mount mismatches already reported on this page, keyed by the pair the
 *  message is about (client baseUrl + the page's prefix). A page routinely
 *  holds several clients — the overlay's and each embed's — and one wiring
 *  mistake printing once per client is a wall of the same paragraph. ONE loud
 *  report, then silence; the throw still reaches every caller. */
const reportedMounts = new Set<string>();

/** 08-ui §2 */
export function createVendoClient(config: VendoClientConfig): VendoClient {
  const baseUrl = config.baseUrl ?? "/api/vendo";
  const headers = { ...(config.headers ?? {}) };

  /** First contact only: a wire route that answers with something that is not a
   *  Vendo envelope means the client and the server disagree about where the
   *  wire is mounted — the #914 shape, seen from the browser. One loud error
   *  naming BOTH sides and the fix beats a mysterious 404 on a page that
   *  otherwise renders perfectly. Checked once; after a real envelope arrives
   *  the mount is proven and the check costs nothing.
   *
   *  The throw alone is not enough: callers that degrade on a failed fetch
   *  (the connector catalog's retry warning) bury it among the page's other
   *  404s, so the one message that names the fix is reported once per page, at
   *  error level, before it is thrown. */
  let mountProven = false;

  async function send(path: string, init?: RequestInit): Promise<Response> {
    const target = joinPath(baseUrl, path);
    const response = await fetch(target, {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!mountProven) {
      if (response.status === 404 && !isWireEnvelope(response)) {
        const mount = pageMount();
        const message = mountMismatchMessage({
          clientBaseUrl: baseUrl,
          requested: target,
          ...(mount === undefined ? {} : { pageMount: mount }),
        });
        const pair = `${baseUrl}|${mount ?? ""}`;
        if (!reportedMounts.has(pair)) {
          reportedMounts.add(pair);
          console.error(message);
        }
        throw new Error(message);
      }
      mountProven = true;
    }
    return ensureOk(response);
  }

  async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await send(path, init);
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
        send("/threads", {
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
      decide: async (ids, decision, options) => {
        const idList = Array.isArray(ids) ? ids : [ids];
        await json("/approvals/decide", "POST", { ids: idList, decision });
        announceApprovalsDecided({
          ids: idList,
          approved: decision.approve,
          ...(options?.grantSetId === undefined ? {} : { grantSetId: options.grantSetId }),
        });
      },
      get: id => readJson(`/approvals/${idPath(id)}`),
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
      // The overloads narrow per call site; one implementation serves both.
      open: ((id: string, options?: { pending?: boolean }) =>
        readJson(`/apps/${idPath(id)}/open${options?.pending === true ? "?pending=1" : ""}`)) as VendoClient["apps"]["open"],
      call: (id, ref, args) => json(`/apps/${idPath(id)}/call`, "POST", { ref, args }),
      edit: (id, instruction) => json(`/apps/${idPath(id)}/edit`, "POST", { instruction }),
      history: id => readJson(`/apps/${idPath(id)}/history`),
      exportApp: async id => new Uint8Array(await (await send(`/apps/${idPath(id)}/export`)).arrayBuffer()),
      importApp: bytes =>
        readJson("/apps/import", {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes as BodyInit,
        }),
      fork: id => json(`/apps/${idPath(id)}/fork`, "POST"),
      shipDiff: id => readJson(`/apps/${idPath(id)}/ship-diff`),
      rebasePin: (id, slot) => json(`/apps/${idPath(id)}/rebase-pin`, "POST", { slot }),
      forkPin: ({ appId, ...body }) =>
        json(appId === undefined ? "/apps/fork-pin" : `/apps/${idPath(appId)}/fork-pin`, "POST", body),
      pingMachine: id => json(`/apps/${idPath(id)}/machine/ping`, "POST"),
      place: (id, slot) => json(`/apps/${idPath(id)}/place`, "POST", { slot }),
      unplace: async (id, slot) => {
        await json(`/apps/${idPath(id)}/unplace`, "POST", { slot });
      },
      placements: slots =>
        readJson(`/apps/placements${slots === undefined || slots.length === 0 ? "" : slotsQuery(slots)}`),
    },
    automations: {
      list: () => readJson("/automations"),
      // The trigger id is a PATH segment after the verb: an automation is an
      // app with a list of triggers, and each verb acts on exactly one of them.
      enable: (id, triggerId) => json(`/automations/${idPath(id)}/enable/${idPath(triggerId)}`, "POST"),
      disable: (id, triggerId) => json(`/automations/${idPath(id)}/disable/${idPath(triggerId)}`, "POST"),
      dryRun: (id, triggerId) => json(`/automations/${idPath(id)}/dry-run/${idPath(triggerId)}`, "POST"),
    },
    runs: {
      list: filter => {
        const params = new URLSearchParams();
        if (filter?.appId !== undefined) params.set("appId", filter.appId);
        if (filter?.triggerId !== undefined) params.set("triggerId", filter.triggerId);
        if (filter?.status !== undefined) params.set("status", filter.status);
        if (filter?.cursor !== undefined) params.set("cursor", filter.cursor);
        const query = params.size > 0 ? `?${params.toString()}` : "";
        return readJson(`/runs${query}`);
      },
      get: id => readJson(`/runs/${idPath(id)}`),
      stop: id => json(`/runs/${idPath(id)}/stop`, "POST"),
      rerun: async id => (await json<{ runId: RunId }>(`/runs/${idPath(id)}/rerun`, "POST")).runId,
    },
    activity: {
      list: params => {
        const query = new URLSearchParams();
        if (params?.cursor !== undefined) query.set("cursor", params.cursor);
        if (params?.limit !== undefined) query.set("limit", String(params.limit));
        return readJson(`/activity${query.size > 0 ? `?${query.toString()}` : ""}`);
      },
    },
    slots: {
      list: () => readJson("/slots"),
      report: slots => json("/slots", "POST", { slots }),
    },
    status: () => readJson("/status"),
  };
}
