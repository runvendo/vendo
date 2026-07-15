import {
  VendoError,
  type AppDocument,
  type AppId,
  type RecordQuery,
  type RunContext,
  type SecretsProvider,
  type ToolRegistry,
  type VendoErrorCode,
} from "@vendoai/core";
import { APP_BLOB_MAX_BYTES, APP_RECORD_MAX_BYTES, type AppDataAccess } from "./app-data.js";
import { hostAllowed, substituteSecretHandles } from "./egress.js";
import type { RunTokenGate } from "./run-token-gate.js";
import { verifyRunToken, type RunTokenSecret } from "./run-token.js";
import { checkEgressUrl, type IpResolver } from "./ssrf.js";

const STATE_BODY_MAX_BYTES = APP_RECORD_MAX_BYTES;
const EGRESS_BODY_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB request envelope ceiling
const EGRESS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB response ceiling
const EGRESS_MAX_REDIRECTS = 5;
const decoder = new TextDecoder();
// Non-fatal so a non-UTF-8 (binary) response is redacted safely rather than throwing.
const lenientDecoder = new TextDecoder("utf-8", { fatal: false });
// vendo-secret:<NAME>:<nonce> — NAME is a declared secret name, nonce is per-boot hex.
const HANDLE_PATTERN = /vendo-secret:([A-Za-z_][A-Za-z0-9_]*):[0-9a-fA-F]+/g;

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const errorResponse = (status: number, code: string, message: string): Response =>
  jsonResponse({ error: { code, message } }, status);

const isJson = (request: Request): boolean => {
  const contentType = request.headers.get("content-type");
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
};

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  return match?.[1] ?? null;
};

/** 06-apps §4.3 — the outbound request an app hands to the proxy for allowlist-gated egress. */
interface EgressEnvelope {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

const parseEnvelope = (value: unknown): EgressEnvelope | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string") return null;
  if (record.method !== undefined && typeof record.method !== "string") return null;
  if (record.body !== undefined && typeof record.body !== "string") return null;
  if (record.headers !== undefined) {
    if (typeof record.headers !== "object" || record.headers === null || Array.isArray(record.headers)) return null;
    for (const header of Object.values(record.headers as Record<string, unknown>)) {
      if (typeof header !== "string") return null;
    }
  }
  return {
    url: record.url,
    ...(record.method === undefined ? {} : { method: record.method as string }),
    ...(record.headers === undefined ? {} : { headers: record.headers as Record<string, string> }),
    ...(record.body === undefined ? {} : { body: record.body as string }),
  };
};

/** Replace every occurrence of a real secret value with a redaction marker (response-path defense). */
const redact = (text: string, values: readonly string[]): string => {
  let output = text;
  for (const value of values) {
    if (value.length === 0) continue;
    output = output.split(value).join("[vendo-secret-redacted]");
  }
  return output;
};

type ProxyRoute =
  | { kind: "tool"; name: string }
  | { kind: "state-get" | "state-put" }
  | { kind: "egress" }
  | { kind: "data-list"; collection: string }
  | { kind: "data-item"; collection: string; id: string }
  | { kind: "file-list"; collection: string }
  | { kind: "file-item"; collection: string; key: string };

const decoded = (value: string): string | null => {
  try {
    const result = decodeURIComponent(value);
    return result === "" ? null : result;
  } catch {
    return null;
  }
};

const collectionRoute = (
  pathname: string,
  prefix: "data" | "files",
): { collection: string; item?: string } | null => {
  const match = new RegExp(`^/${prefix}/([^/]+)(?:/(.+))?$`).exec(pathname);
  if (match?.[1] === undefined) return null;
  const collection = decoded(match[1]);
  const item = match[2] === undefined ? undefined : decoded(match[2]);
  if (collection === null || item === null) return null;
  return { collection, ...(item === undefined ? {} : { item }) };
};

const routeFor = (request: Request, pathname: string): ProxyRoute | null => {
  const toolMatch = /^\/tools\/([a-zA-Z0-9_-]{1,64})$/.exec(pathname);
  if (request.method === "POST" && toolMatch?.[1] !== undefined) {
    return { kind: "tool", name: toolMatch[1] };
  }
  if (pathname === "/state" && request.method === "GET") return { kind: "state-get" };
  if (pathname === "/state" && request.method === "PUT") return { kind: "state-put" };
  if (pathname === "/egress" && request.method === "POST") return { kind: "egress" };

  const data = collectionRoute(pathname, "data");
  if (data !== null) {
    if (data.item === undefined && request.method === "GET") {
      return { kind: "data-list", collection: data.collection };
    }
    if (data.item !== undefined && ["GET", "PUT", "DELETE"].includes(request.method)) {
      return { kind: "data-item", collection: data.collection, id: data.item };
    }
  }
  const files = collectionRoute(pathname, "files");
  if (files !== null) {
    if (files.item === undefined && request.method === "GET") {
      return { kind: "file-list", collection: files.collection };
    }
    if (files.item !== undefined && ["GET", "PUT", "DELETE"].includes(request.method)) {
      return { kind: "file-item", collection: files.collection, key: files.item };
    }
  }
  return null;
};

const readJson = async (request: Request, maxBytes?: number): Promise<unknown> => {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
    throw new VendoError("validation", "request body exceeds size limit");
  }
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch {
    throw new VendoError("validation", "request body must be valid JSON");
  }
};

const objectBody = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
};

const recordQuery = (url: URL): RecordQuery => {
  const refs: Record<string, string> = {};
  let limit: number | undefined;
  let cursor: string | undefined;
  for (const [key, value] of url.searchParams) {
    if (key.startsWith("refs.")) {
      const ref = key.slice("refs.".length);
      if (ref === "" || value === "") {
        throw new VendoError("validation", "ref filters require non-empty keys and values");
      }
      refs[ref] = value;
      continue;
    }
    if (key === "limit") {
      if (!/^[1-9]\d*$/.test(value)) {
        throw new VendoError("validation", "limit must be a positive integer");
      }
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) {
        throw new VendoError("validation", "limit must be a positive integer");
      }
      continue;
    }
    if (key === "cursor") {
      if (value === "") throw new VendoError("validation", "cursor must be a non-empty string");
      cursor = value;
      continue;
    }
    throw new VendoError("validation", `unknown list query parameter: ${key}`);
  }
  return {
    ...(Object.keys(refs).length === 0 ? {} : { refs }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
};

/** 06-apps §1 plus ENG-259 egress additions — internal dependencies for the fetch-style proxy. */
export interface AppsProxyDependencies {
  tokenSecret: RunTokenSecret;
  tools: ToolRegistry;
  data: AppDataAccess;
  owns(appId: AppId, subject: string): Promise<boolean>;
  /** Load the owner's app document — supplies the egress allowlist and declared secret names. */
  loadApp(appId: AppId, subject: string): Promise<AppDocument | null>;
  /** Resolves declared secret handles to real values, ONLY inside the proxy, ONLY for allowlisted egress. */
  secrets?: SecretsProvider;
  /** Override the outbound transport (tests, instrumentation); defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Override DNS resolution (tests, edge hosts); defaults to node:dns. */
  resolveIp?: IpResolver;
  /** ENG-251 — anti-replay gate. A run token stays valid for EVERY callback of its
      live run (tools, state, egress — a run legitimately makes many), but the moment
      its machine is torn down the machine cache burns its jti here, so a captured
      token replayed afterwards is refused even though its HMAC and TTL still verify. */
  consumedRunTokens?: RunTokenGate;
}

/** 06-apps §4.4 and plan decision 3 — fetch-style machine capability proxy. */
export const createAppsProxy = (dependencies: AppsProxyDependencies): { handler(request: Request): Promise<Response> } => {
  const outboundFetch = dependencies.fetch ?? globalThis.fetch;

  // ENG-259 — resolve declared-secret handles present in THIS request to real values.
  // Nonce-agnostic by design: the nonce is read from the request itself (so it works for
  // both freshly-created and snapshot-resumed machines), and only names the app DECLARED
  // are ever resolved. The app is already entitled to its declared secrets toward
  // allowlisted hosts, so reading the nonce from the request grants nothing new.
  const buildHandleMap = async (
    app: AppDocument,
    envelope: EgressEnvelope,
  ): Promise<{ handleMap: Record<string, string>; values: string[] }> => {
    const handleMap: Record<string, string> = {};
    const values: string[] = [];
    if (dependencies.secrets === undefined) return { handleMap, values };
    const declared = new Set(app.secrets ?? []);
    const scanned = JSON.stringify({ headers: envelope.headers ?? {}, body: envelope.body ?? "" });
    const seen = new Set<string>();
    for (const match of scanned.matchAll(HANDLE_PATTERN)) {
      const handle = match[0];
      const name = match[1] as string;
      if (seen.has(handle) || !declared.has(name)) continue;
      seen.add(handle);
      const value = await dependencies.secrets.get(name);
      if (value !== undefined && value.length > 0) {
        handleMap[handle] = value;
        values.push(value);
      }
    }
    return { handleMap, values };
  };

  // ENG-259 — forward with manual redirect following; re-validate SSRF + allowlist on EVERY hop.
  const forward = async (
    request: { url: string; method: string; headers: Record<string, string>; body?: string },
    allowlist: readonly string[],
  ): Promise<{ status: number; headers: Record<string, string>; body: string } | { blocked: string }> => {
    let target = request.url;
    for (let hop = 0; hop <= EGRESS_MAX_REDIRECTS; hop += 1) {
      const host = (() => {
        try {
          return new URL(target).hostname;
        } catch {
          return null;
        }
      })();
      if (host === null || !hostAllowed(host, allowlist)) return { blocked: "host-not-allowlisted" };
      const vetted = await checkEgressUrl(target, { ...(dependencies.resolveIp === undefined ? {} : { resolve: dependencies.resolveIp }) });
      if (!vetted.ok) return { blocked: vetted.reason };

      const response = await outboundFetch(target, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: "manual",
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) return { blocked: "redirect-without-location" };
        try {
          target = new URL(location, target).toString();
        } catch {
          return { blocked: "redirect-invalid-location" };
        }
        continue; // re-validate the new hop at the top of the loop
      }

      const buffer = await response.arrayBuffer();
      const bytes = buffer.byteLength > EGRESS_RESPONSE_MAX_BYTES
        ? new Uint8Array(buffer, 0, EGRESS_RESPONSE_MAX_BYTES)
        : new Uint8Array(buffer);
      const headers: Record<string, string> = {};
      for (const [name, value] of response.headers.entries()) headers[name] = value;
      return { status: response.status, headers, body: lenientDecoder.decode(bytes) };
    }
    return { blocked: "too-many-redirects" };
  };

  const handleEgress = async (payload: { appId: AppId; subject: string }, envelope: EgressEnvelope): Promise<Response> => {
    const app = await dependencies.loadApp(payload.appId, payload.subject);
    if (app === null) return errorResponse(404, "not-found", "app not found");
    const allowlist = app.egress ?? [];

    // 1. Allowlist gate FIRST (cheap, no DNS, no secret read) — non-allowlisted host is refused
    //    with no substitution and no forward. `new URL().hostname` collapses the userinfo trick
    //    (https://api.stripe.com@evil.com → evil.com), so it is refused here.
    let hostname: string;
    try {
      hostname = new URL(envelope.url).hostname;
    } catch {
      return errorResponse(400, "validation", "egress url is not a valid absolute URL");
    }
    if (!hostAllowed(hostname, allowlist)) {
      return errorResponse(403, "egress-blocked", "host is not in the app egress allowlist");
    }

    // 2. SSRF / private-address gate on the RESOLVED IPs (rebind-resistant).
    const vetted = await checkEgressUrl(envelope.url, { ...(dependencies.resolveIp === undefined ? {} : { resolve: dependencies.resolveIp }) });
    if (!vetted.ok) return errorResponse(403, "egress-blocked", `egress refused: ${vetted.reason}`);

    // 3. Only now — egress is permitted — resolve declared secrets and substitute in headers/body.
    const { handleMap, values } = await buildHandleMap(app, envelope);
    const substituted = substituteSecretHandles(
      { url: envelope.url, ...(envelope.headers === undefined ? {} : { headers: envelope.headers }), ...(envelope.body === undefined ? {} : { body: envelope.body }) },
      handleMap,
      allowlist,
    );

    // 4. Forward (never send our run token to the target), re-validating each redirect hop.
    const result = await forward({
      url: substituted.url,
      method: (envelope.method ?? "GET").toUpperCase(),
      headers: (substituted.headers as Record<string, string> | undefined) ?? {},
      ...(typeof substituted.body === "string" ? { body: substituted.body } : {}),
    }, allowlist);
    if ("blocked" in result) return errorResponse(403, "egress-blocked", `egress refused: ${result.blocked}`);

    // 5. Strip any reflected secret from the response path before it returns to app code.
    const responseHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(result.headers)) responseHeaders[name] = redact(value, values);
    return jsonResponse({ status: result.status, headers: responseHeaders, body: redact(result.body, values) });
  };

  return {
    async handler(request) {
      const url = new URL(request.url);
      const route = routeFor(request, url.pathname);
      if (route === null) return errorResponse(404, "not-found", "unknown proxy route");
      if (["tool", "state-put", "egress"].includes(route.kind)
        || (route.kind === "data-item" && request.method === "PUT")) {
        if (!isJson(request)) {
          return errorResponse(400, "validation", "content-type must be application/json");
        }
      }
      if (route.kind === "file-item" && request.method === "PUT") {
        const contentType = request.headers.get("content-type");
        if (contentType === null || contentType.trim() === "") {
          return errorResponse(400, "validation", "content-type is required");
        }
      }
      const token = bearerToken(request);
      const payload = token === null ? null : await verifyRunToken(dependencies.tokenSecret, token);
      if (payload === null) return errorResponse(401, "unauthorized", "invalid or expired run token");
      // ENG-251 anti-replay. This gates EVERY proxy route (tools, state, egress)
      // identically: the token is good for as long as its run is live — a run
      // legitimately makes many calls, and /egress especially — but once the run's
      // machine is evicted its jti is burned and a replay of the captured bearer is
      // refused here, shrinking the replay window from the full TTL to the live run.
      if (dependencies.consumedRunTokens?.isConsumed(payload.jti)) {
        return errorResponse(401, "unauthorized", "run token has been revoked");
      }
      if (!await dependencies.owns(payload.appId, payload.subject)) {
        return errorResponse(404, "not-found", "app not found");
      }
      const runCtx: RunContext = {
        principal: { kind: "user", subject: payload.subject },
        venue: "app",
        presence: payload.presence,
        sessionId: payload.runId,
        appId: payload.appId,
      };

      try {
        if (route.kind === "state-get") {
          return jsonResponse(await dependencies.data.getState(payload.appId, payload.subject));
        }
        if (route.kind === "egress") {
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > EGRESS_BODY_MAX_BYTES) {
            return errorResponse(400, "validation", "egress request exceeds size limit");
          }
          let envelope: EgressEnvelope | null;
          try {
            envelope = parseEnvelope(JSON.parse(decoder.decode(bytes)) as unknown);
          } catch {
            return errorResponse(400, "validation", "egress request body must be valid JSON");
          }
          if (envelope === null) {
            return errorResponse(400, "validation", "egress request must be { url, method?, headers?, body? }");
          }
          return handleEgress(payload, envelope);
        }
        if (route.kind === "state-put") {
          await dependencies.data.setState(
            payload.appId,
            payload.subject,
            await readJson(request, STATE_BODY_MAX_BYTES) as never,
          );
          return jsonResponse({ status: "ok" });
        }

        let app: AppDocument | undefined;
        if (["data-list", "data-item", "file-list", "file-item"].includes(route.kind)) {
          app = await dependencies.loadApp(payload.appId, payload.subject) ?? undefined;
          if (app === undefined) throw new VendoError("not-found", "app not found");
        }
        if (route.kind === "data-list") {
          return jsonResponse(await dependencies.data.records(app as AppDocument, route.collection).list(recordQuery(url)));
        }
        if (route.kind === "data-item") {
          const records = dependencies.data.records(app as AppDocument, route.collection);
          if (request.method === "GET") {
            const record = await records.get(route.id);
            if (record === null) throw new VendoError("not-found", `record not found: ${route.id}`);
            return jsonResponse(record);
          }
          if (request.method === "DELETE") {
            await records.delete(route.id);
            return jsonResponse({ status: "ok" });
          }
          const body = objectBody(await readJson(request, APP_RECORD_MAX_BYTES), "record body");
          const unexpected = Object.keys(body).find((key) => key !== "data" && key !== "refs");
          if (unexpected !== undefined) {
            throw new VendoError("validation", `unexpected record property: ${unexpected}`);
          }
          if (!Object.prototype.hasOwnProperty.call(body, "data")) {
            throw new VendoError("validation", "record body must contain data");
          }
          return jsonResponse(await records.put({
            id: route.id,
            data: body.data as never,
            ...(body.refs === undefined ? {} : { refs: body.refs as Record<string, string> }),
          }));
        }
        if (route.kind === "file-list") {
          return jsonResponse(await dependencies.data.blobs(app as AppDocument, route.collection).list());
        }
        if (route.kind === "file-item") {
          const blobs = dependencies.data.blobs(app as AppDocument, route.collection);
          if (request.method === "GET") {
            const blob = await blobs.get(route.key);
            if (blob === null) throw new VendoError("not-found", `file not found: ${route.key}`);
            return new Response(blob.bytes, {
              headers: { "content-type": blob.contentType ?? "application/octet-stream" },
            });
          }
          if (request.method === "DELETE") {
            await blobs.delete(route.key);
            return jsonResponse({ status: "ok" });
          }
          const contentLength = request.headers.get("content-length");
          if (contentLength !== null && Number(contentLength) > APP_BLOB_MAX_BYTES) {
            throw new VendoError("validation", "request body exceeds size limit");
          }
          const bytes = new Uint8Array(await request.arrayBuffer());
          await blobs.put(route.key, bytes, { contentType: request.headers.get("content-type") ?? undefined });
          return jsonResponse({ status: "ok" });
        }

        if (route.kind !== "tool") return errorResponse(404, "not-found", "unknown proxy route");
        const body = objectBody(await readJson(request), "tool body");
        if (!Object.prototype.hasOwnProperty.call(body, "args")) {
          throw new VendoError("validation", "tool body must be an object containing args");
        }
        return jsonResponse(await dependencies.tools.execute({
          id: `call_${globalThis.crypto.randomUUID()}`,
          tool: route.name,
          args: body.args as never,
        }, runCtx));
      } catch (error) {
        if (error instanceof VendoError) {
          return errorResponse(STATUS_BY_CODE[error.code], error.code, error.message);
        }
        return errorResponse(500, "internal", error instanceof Error ? error.message : "unknown proxy error");
      }
    },
  };
};
