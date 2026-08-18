import { defaultFetch, joinUrl, type ToolOutcome, VendoError } from "@vendoai/core";
import type { HttpMethod, OpenApiBinding, PrimitiveToolBinding, RouteBinding, TrpcBinding } from "../formats.js";
import { error } from "./outcome.js";

/**
 * The HTTP leg every API-backed tool call travels: bind arguments onto the
 * binding's declared shape, then make the request. Shared by the registry's
 * host tools and by `openApiConnector`, so a spec handed to the connector
 * executes through exactly the path `.vendo/tools.json` executes through.
 *
 * Authentication is NOT here: who a call is made as is the caller's business
 * (the registry's ActAs/forwarding rules, the connector's headers resolver).
 */

/** The HTTP request one tool call becomes. */
export interface HostRequest {
  url: URL;
  method: HttpMethod;
  body: string | undefined;
}

function appendQuery(url: URL, key: string, value: unknown): void {
  const values = Array.isArray(value) ? value : [value];
  for (const item of values) {
    const encoded = item !== null && typeof item === "object" ? JSON.stringify(item) : String(item);
    url.searchParams.append(key, encoded);
  }
}

/** Encode one substituted path segment. `encodeURIComponent` neutralizes a
 *  slash (→ `%2F`) but leaves `.` and `..` intact, so a call arg of "." or ".."
 *  would substitute as a literal dot-segment that `new URL` later normalizes to
 *  climb above the tool's declared route (path traversal / SSRF, #988). Args are
 *  never validated against `inputSchema` and are steerable by end-user chat, so
 *  reject the traversal segment at the source. */
function encodePathSegment(raw: string): string {
  const encoded = encodeURIComponent(raw);
  if (encoded === "." || encoded === "..") {
    throw new VendoError("validation", `Path parameter cannot be a "${encoded}" traversal segment`);
  }
  return encoded;
}

function withPathArgs(path: string, args: Record<string, unknown>): { path: string; remaining: Record<string, unknown> } {
  const consumed = new Set<string>();
  const resolved = path.replace(/\{([^{}]+)\}/g, (_match, param: string) => {
    if (!Object.prototype.hasOwnProperty.call(args, param) || args[param] === undefined) {
      throw new VendoError("validation", `Missing required path parameter: ${param}`);
    }
    consumed.add(param);
    const value = args[param];
    return Array.isArray(value)
      ? value.map((segment) => encodePathSegment(String(segment))).join("/")
      : encodePathSegment(String(value));
  });
  return {
    path: resolved,
    remaining: Object.fromEntries(Object.entries(args).filter(([key]) => !consumed.has(key))),
  };
}

/**
 * How a failed host call names what it called: origin **and** path. A wire
 * origin pointing at the wrong host 404s every tool while every path is
 * correct, and a message carrying only the path reads exactly like a malformed
 * path — so the origin is never omitted.
 *
 * Assembled from the URL's safe parts rather than scrubbed after the fact:
 * `host` cannot contain userinfo, and dropping `search` drops query-string
 * tokens. A baseUrl may carry either (`https://svc:pw@host`,
 * `https://ghp_x@host`, `?access_token=…`) and this string reaches host logs
 * and the model.
 */
function requestTarget(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

function resolveUrl(binding: RouteBinding | OpenApiBinding, configuredBaseUrl?: string): URL {
  let baseUrl: string | undefined;
  if (binding.kind === "openapi" && binding.baseUrl) {
    try {
      const candidate = new URL(binding.baseUrl);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") baseUrl = binding.baseUrl;
    } catch {
      // Relative OpenAPI server URLs intentionally fall back to the host origin.
    }
  }
  baseUrl ??= configuredBaseUrl;
  if (!baseUrl) {
    throw new VendoError(
      "validation",
      `Cannot execute ${binding.kind} binding ${binding.path}; set VENDO_BASE_URL, or pass baseUrl, for server-side route execution`,
    );
  }
  try {
    return joinUrl(baseUrl, binding.path);
  } catch {
    throw new VendoError("validation", `Invalid baseUrl for ${binding.path}; set createActions({ baseUrl }) to a valid origin`);
  }
}

/** The tRPC HTTP envelope (04 §1): queries GET `{mount}/{procedure}?input=...`,
 * mutations POST the input as the JSON body. Hosts whose tRPC root applies the
 * superjson transformer expect the `{ json: ... }` wrapping — which is exactly
 * `superjson.serialize(value)` for every value that can traverse the agent
 * tool-call wire (plain JSON; no Date/Map/Set instances exist there, so no
 * `meta` is ever needed). Known limitation: a host validator that demands a
 * rich type (e.g. `z.date()`) rejects the ISO string visibly as a tRPC 400 —
 * request-path date coercion via schema-informed `meta` is a follow-up. */
function trpcRequest(binding: TrpcBinding, args: Record<string, unknown>, configuredBaseUrl?: string): {
  url: URL;
  method: HttpMethod;
  body?: string;
} {
  if (!configuredBaseUrl) {
    throw new VendoError(
      "validation",
      `Cannot execute trpc binding ${binding.procedure}; set VENDO_BASE_URL, or pass baseUrl, for server-side trpc execution`,
    );
  }
  let url: URL;
  try {
    url = joinUrl(configuredBaseUrl, `${binding.mount.replace(/\/$/, "")}/${binding.procedure}`);
  } catch {
    throw new VendoError("validation", `Invalid baseUrl for trpc procedure ${binding.procedure}; set createActions({ baseUrl }) to a valid origin`);
  }
  const payload = Object.keys(args).length > 0
    ? (binding.transformer === "superjson" ? { json: args } : args)
    : undefined;
  if (binding.type === "query") {
    if (payload !== undefined) url.searchParams.set("input", JSON.stringify(payload));
    return { url, method: "GET" };
  }
  return { url, method: "POST", ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) };
}

/** Unwrap the tRPC success envelope: `{ result: { data } }`, with superjson's
 * `{ json }` wrapping inside `data` when the host applies the transformer.
 * `meta` is intentionally ignored: rich types come back as their JSON
 * projections (ISO strings etc.), the format the agent layer consumes. */
function trpcOutput(binding: TrpcBinding, parsed: unknown): unknown {
  const result = parsed !== null && typeof parsed === "object" && "result" in parsed
    ? (parsed as { result: unknown }).result
    : undefined;
  const data = result !== null && typeof result === "object" && result !== undefined && "data" in result
    ? (result as { data: unknown }).data
    : parsed;
  if (binding.transformer === "superjson" && data !== null && typeof data === "object" && "json" in (data as Record<string, unknown>)) {
    return (data as { json: unknown }).json;
  }
  return data;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

/** Bind the call's arguments onto the tool's declared shape: the tRPC envelope,
 *  or path substitution and then query/body per the binding's `argsIn`. */
export function hostRequest(
  binding: RouteBinding | OpenApiBinding | TrpcBinding,
  args: Record<string, unknown>,
  tool: string,
  configuredBaseUrl?: string,
): { request: HostRequest } | { error: ToolOutcome } {
  let url: URL;
  let method: HttpMethod;
  let body: string | undefined;
  try {
    if (binding.kind === "trpc") {
      const request = trpcRequest(binding, args, configuredBaseUrl);
      url = request.url;
      method = request.method;
      body = request.body;
    } else {
      method = binding.method;
      const substituted = withPathArgs(binding.path, args);
      url = resolveUrl({ ...binding, path: substituted.path }, configuredBaseUrl);
      if (binding.kind === "route") {
        if (binding.argsIn === "query") {
          for (const [key, value] of Object.entries(substituted.remaining)) appendQuery(url, key, value);
        } else {
          body = JSON.stringify(substituted.remaining);
        }
      } else {
        const remaining = { ...substituted.remaining };
        if (Object.prototype.hasOwnProperty.call(remaining, "body")) {
          body = JSON.stringify(remaining.body);
          delete remaining.body;
        }
        for (const [key, value] of Object.entries(remaining)) appendQuery(url, key, value);
      }
    }
  } catch (cause) {
    return { error: error("validation", cause instanceof Error ? cause.message : `Invalid arguments for ${tool}`) };
  }
  return { request: { url, method, body } };
}

/** The request itself. Every failure — transport, status, body — comes back as
 *  an outcome, so the caller's audit enrichment always runs. `headers` carries
 *  whatever the caller authenticates with; the JSON envelope is set here. */
export async function fetchHostTool(
  binding: PrimitiveToolBinding,
  tool: string,
  { url, method, body }: HostRequest,
  headers: Record<string, string>,
  fetchImpl?: typeof fetch,
): Promise<ToolOutcome> {
  setHeader(headers, "accept", "application/json");
  if (body !== undefined) setHeader(headers, "content-type", "application/json");
  try {
    const request = fetchImpl ?? defaultFetch;
    const response = await request(url, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
      return error(
        "http-error",
        `${method} ${requestTarget(url)} → ${response.status}: ${text.slice(0, 200)}`,
      );
    }
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        return {
          status: "ok",
          output: binding.kind === "trpc" ? trpcOutput(binding, parsed) : parsed,
        };
      } catch {
        // Successful non-JSON responses retain their HTTP status and text.
      }
    }
    return { status: "ok", output: { status: response.status, text } };
  } catch (cause) {
    return error("network-error", cause instanceof Error ? cause.message : `Network request failed for ${tool}`);
  }
}
