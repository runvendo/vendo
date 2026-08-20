/**
 * The shared HTTP route runtime: the mount-relative path, the route-table types
 * and matcher, the envelope helpers, and the param validators.
 *
 * Generic in the per-request context, because the matcher only ever READS
 * `request`/`path`/`segments` and WRITES `params` — whatever else a caller hangs
 * off its own context (composed deps, a RunContext resolver) is invisible here.
 * `@vendoai/vendo`'s wire binds this to its own WireContext (wire/shared.ts).
 */
import { isVendoError, VendoError, type VendoErrorCode } from "@vendoai/core";

export function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    === "application/json";
}

/** The mount-relative raw path a route table matches on, or null when the URL
    falls outside the mount entirely (the caller answers not-found). */
export function relativePath(mount: string, url: URL): string | null {
  if (url.pathname === mount) return "/";
  if (!url.pathname.startsWith(`${mount}/`)) return null;
  return url.pathname.slice(mount.length);
}

/** What the matcher needs from a per-request context: the raw request, the
    mount-relative raw path, the decoded segments, and the slot the matched
    entry's `:param` captures land in. */
export interface RouteContext {
  request: Request;
  path: string;
  readonly segments: string[];
  params: Record<string, string>;
}

/** A handler answers with a Response, or returns undefined to FALL THROUGH to
    the next entry — mirroring the old if-chain, where a matched-path block
    whose method/operation checks all missed simply fell out the bottom (any
    side effects it ran, e.g. context resolution, stand). */
export type RouteHandler<W extends RouteContext> = (wire: W) => Promise<Response | undefined>;

type RoutePattern =
  /** Raw-path equality — no decoding, matching the old `path === "/x"` arms. */
  | { kind: "exact"; path: string }
  /** Raw-path prefix — matching the old `path.startsWith("/x/")` arms. */
  | { kind: "prefix"; prefix: string }
  /** Decoded-segment match: literals compare against decoded values, `:name`
      captures, a trailing rest wildcard allows ZERO or more extra segments —
      matching the old `head === "x" && segments.length >= n` arms. */
  | { kind: "segments"; parts: string[]; rest: boolean };

export interface RouteEntry<W extends RouteContext> {
  /** Exact method, or "*" for grouped handlers that dispatch methods inside. */
  method: string;
  pattern: RoutePattern;
  handler: RouteHandler<W>;
}

/** Table entry from a pattern string: no `:param` and no trailing `/*` means
    raw-path equality; otherwise decoded-segment matching (trailing `/*` = rest
    wildcard, zero or more segments). */
export function route<W extends RouteContext>(method: string, pattern: string, handler: RouteHandler<W>): RouteEntry<W> {
  if (!pattern.includes(":") && !pattern.endsWith("/*")) {
    return { method, pattern: { kind: "exact", path: pattern }, handler };
  }
  const rest = pattern.endsWith("/*");
  const parts = (rest ? pattern.slice(0, -2) : pattern).split("/").filter(Boolean);
  return { method, pattern: { kind: "segments", parts, rest }, handler };
}

/** Table entry matching on a raw path prefix (webhooks, proxy, the doctor
    production gate) — never decodes, exactly like the old startsWith arms.
    Raw string match, no segment boundary — include the trailing slash. */
export function prefixRoute<W extends RouteContext>(method: string, prefix: string, handler: RouteHandler<W>): RouteEntry<W> {
  return { method, pattern: { kind: "prefix", prefix }, handler };
}

function matchRoute<W extends RouteContext>(entry: RouteEntry<W>, wire: W): Record<string, string> | null {
  if (entry.method !== "*" && entry.method !== wire.request.method) return null;
  const pattern = entry.pattern;
  if (pattern.kind === "exact") return pattern.path === wire.path ? {} : null;
  if (pattern.kind === "prefix") return wire.path.startsWith(pattern.prefix) ? {} : null;
  // Segment access may throw the invalid-encoding validation error — only ever
  // reached after every raw pre-route entry has had its chance, preserving the
  // old chain's ordering (prefix routes served /proxy/%zz; /threads/%zz threw).
  const segments = wire.segments;
  if (pattern.rest ? segments.length < pattern.parts.length : segments.length !== pattern.parts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.parts.length; i++) {
    const part = pattern.parts[i]!;
    if (part.startsWith(":")) params[part.slice(1)] = segments[i]!;
    else if (part !== segments[i]) return null;
  }
  return params;
}

/** Scan the table in order; a handler returning undefined keeps scanning
    (fall-through). No match → undefined; the caller answers not-found. */
export async function dispatchRoutes<W extends RouteContext>(
  routes: readonly RouteEntry<W>[],
  wire: W,
): Promise<Response | undefined> {
  for (const entry of routes) {
    const params = matchRoute(entry, wire);
    if (params === null) continue;
    wire.params = params;
    const response = await entry.handler(wire);
    if (response !== undefined) return response;
  }
  return undefined;
}

const STATUS_BY_CODE: Record<VendoErrorCode, number> = {
  validation: 400,
  "not-found": 404,
  blocked: 403,
  // Build contract §9.4 — the caller sees the thing but may not do this to it.
  forbidden: 403,
  conflict: 409,
  "cloud-required": 402,
  "sandbox-unavailable": 501,
  "not-implemented": 501,
  // Table entry only, for the same reason knowledge-wire.ts's copy carries
  // one: this wire builds its OWN VendoError responses and never parses a
  // status code back into one, so there is no STATUS_TO_CODE here to extend.
  unavailable: 503,
  // Same: a schema proposal is a typed store's answer to its own client, and
  // this wire has no table to propose.
  "schema-proposal": 409,
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function errorResponse(error: VendoError): Response {
  return json({ error: { code: error.code, message: error.message } }, STATUS_BY_CODE[error.code]);
}

export function internalError(): Response {
  return errorResponse(new VendoError("not-implemented", "Internal Vendo error"));
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VendoError("validation", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new VendoError("validation", `${label} must be a non-empty string`);
  }
  return value;
}

export async function requestJson(request: Request): Promise<Record<string, unknown>> {
  try {
    return object(await request.json(), "request body");
  } catch (error) {
    if (isVendoError(error)) throw error;
    throw new VendoError("validation", "request body must be valid JSON");
  }
}

export function routeSegments(path: string): string[] {
  try {
    return path.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new VendoError("validation", "route contains invalid URL encoding");
  }
}

/** Bytes → lowercase hex. Used by wire/misc.ts's timing-safe digest compare. */
export function hex(bytes: ArrayBuffer | Uint8Array): string {
  let out = "";
  for (const b of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) out += b.toString(16).padStart(2, "0");
  return out;
}
