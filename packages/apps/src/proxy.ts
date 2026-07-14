import type { AppDocument, AppId, RunContext, SecretsProvider, ToolRegistry } from "@vendoai/core";
import type { AppDataAccess } from "./app-data.js";
import { hostAllowed, substituteSecretHandles } from "./egress.js";
import { verifyRunToken, type RunTokenSecret } from "./run-token.js";
import { checkEgressUrl, type IpResolver } from "./ssrf.js";

const STATE_BODY_MAX_BYTES = 256 * 1024;
const EGRESS_BODY_MAX_BYTES = 1 * 1024 * 1024; // 1 MiB request envelope ceiling
const EGRESS_RESPONSE_MAX_BYTES = 4 * 1024 * 1024; // 4 MiB response ceiling
const EGRESS_MAX_REDIRECTS = 5;
const decoder = new TextDecoder();
// Non-fatal so a non-UTF-8 (binary) response is redacted safely rather than throwing.
const lenientDecoder = new TextDecoder("utf-8", { fatal: false });
// vendo-secret:<NAME>:<nonce> — NAME is a declared secret name, nonce is per-boot hex.
const HANDLE_PATTERN = /vendo-secret:([A-Za-z_][A-Za-z0-9_]*):[0-9a-fA-F]+/g;

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
      const toolMatch = /^\/tools\/([a-zA-Z0-9_-]{1,64})$/.exec(url.pathname);
      const isTool = request.method === "POST" && toolMatch?.[1] !== undefined;
      const isStateGet = request.method === "GET" && url.pathname === "/state";
      const isStatePut = request.method === "PUT" && url.pathname === "/state";
      const isEgress = request.method === "POST" && url.pathname === "/egress";
      if (!isTool && !isStateGet && !isStatePut && !isEgress) {
        return errorResponse(404, "not-found", "unknown proxy route");
      }
      if ((isTool || isStatePut || isEgress) && !isJson(request)) {
        return errorResponse(400, "validation", "content-type must be application/json");
      }
      const token = bearerToken(request);
      const payload = token === null ? null : await verifyRunToken(dependencies.tokenSecret, token);
      if (payload === null) return errorResponse(401, "unauthorized", "invalid or expired run token");
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

      if (isStateGet) {
        return jsonResponse(await dependencies.data.getState(payload.appId, payload.subject));
      }
      if (isEgress) {
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
      let body: unknown;
      try {
        if (isStatePut) {
          const bytes = new Uint8Array(await request.arrayBuffer());
          if (bytes.byteLength > STATE_BODY_MAX_BYTES) {
            return errorResponse(400, "validation", "request body exceeds size limit");
          }
          body = JSON.parse(decoder.decode(bytes)) as unknown;
        } else {
          body = await request.json();
        }
      } catch {
        return errorResponse(400, "validation", "request body must be valid JSON");
      }
      if (isStatePut) {
        await dependencies.data.setState(payload.appId, payload.subject, body);
        return jsonResponse({ status: "ok" });
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)
        || !Object.prototype.hasOwnProperty.call(body, "args")) {
        return errorResponse(400, "validation", "tool body must be an object containing args");
      }
      const tool = toolMatch?.[1];
      if (tool === undefined) return errorResponse(404, "not-found", "unknown proxy route");
      const outcome = await dependencies.tools.execute({
        id: `call_${globalThis.crypto.randomUUID()}`,
        tool,
        args: (body as { args: unknown }).args,
      }, runCtx);
      return jsonResponse(outcome);
    },
  };
};
