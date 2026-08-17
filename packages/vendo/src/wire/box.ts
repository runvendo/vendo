import type { BoxRequest, BoxResponse } from "@vendoai/apps";
import { VendoError, type Json, type RecordQuery, type RunContext } from "@vendoai/core";
import { json, prefixRoute, route, string, type RouteEntry, type WireContext } from "./shared.js";

/** execution-v2 skin contract (Lane C) — the two wire surfaces on the boundary
    of the box:
    1. the fn PROXY (`POST /apps/:appId/fn/:name`): the authenticated end-user
       route that wakes the app's machine through the apps runtime's box door
       and forwards ONE request to the box's `POST /fn/<name>`, relaying
       status/body. The tree side of the contract.
    2. the CALLBACK surface (`/box/...`): plain HTTP, authenticated by the
       per-app bearer minted at provision (createAppTokens), curl-able from any
       language inside the box — durable rows over the app-scoped store, and
       host tools through the SAME guard-bound registry chat uses (approvals
       and audit intact; a pending approval relays as its pending outcome,
       never bypasses). The box side of the contract. The box never holds host
       credentials — this surface is its single authority path. */

/** The fn-name half of core's 01 §8 grammar (mirrored in manifest.ts). */
const FN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
/** Wire-side ceiling on one fn round-trip. The box is a wake-in-a-second
    sandbox answering a function call, not a batch job; a slower answer should
    time out loudly at the tree side rather than hold the host request open. */
const FN_TIMEOUT_MS = 30_000;

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const COLLECTION_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Matches the app-data record ceiling (06-apps §6). */
const ROW_MAX_BYTES = 256 * 1024;

const decoder = new TextDecoder();

const TIMED_OUT: unique symbol = Symbol("vendo-box-timeout");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The payload, and ONLY the payload: method, path, content-type, body. Nothing
    else may ride into the box — no cookie, no authorization, no host header —
    and both doors below assemble their request from here so the skin has one
    shape rather than two that drift. */
async function payloadOf(request: Request, method: string, path: string): Promise<BoxRequest> {
  const body = new Uint8Array(await request.arrayBuffer());
  const contentType = request.headers.get("content-type");
  return {
    method,
    path,
    ...(contentType === null ? {} : { headers: { "content-type": contentType } }),
    ...(body.byteLength === 0 ? {} : { body }),
  };
}

/** The box's answer, relayed. Of its headers only content-type crosses back: no
    set-cookie or friends may be smuggled onto the host origin by a box process.
    The other half of the one shape — same reason, same single place. */
function relayAnswer(answer: BoxResponse): Response {
  const relayType = Object.entries(answer.headers)
    .find(([header]) => header.toLowerCase() === "content-type")?.[1];
  return new Response(answer.body.byteLength === 0 ? null : (answer.body as BodyInit), {
    status: answer.status,
    ...(relayType === undefined ? {} : { headers: { "content-type": relayType } }),
  });
}

/** Build contract §9.8 — a served ORG app's registered URL is THIS route, so
    the browser's every request re-checks `can(viewer)` against live rows. A
    served process gets no cookies and no host credentials: only the payload
    crosses, exactly as the fn proxy above. Modelled on it deliberately —
    the skin has one shape, not two. */
export const servedProxyRoutes: RouteEntry[] = [
  route("*", "/apps/:appId/serve/*", async (wire) => {
    const { request, params, deps } = wire;
    const appId = string(params["appId"], "app id");
    const ctx = await wire.context("app");
    // Everything after `/apps/<id>/serve` is the path INSIDE the box, QUERY
    // STRING included: a parameterized request must arrive parameterized, or
    // every served app that reads one (?tab=, ?vendoTheme=, pagination) breaks
    // the moment the app is shared. Still payload only — the search string is
    // part of what the caller asked for, not host authority.
    //
    // Split `wire.path` (raw), NOT `wire.segments` (percent-DECODED): this path
    // is concatenated into the box's fetch URL, so a decoded `%2F` would become
    // a real separator and a decoded `%3F` would start a query nobody sent.
    const raw = wire.path.split("/").filter(Boolean);
    const inner = `/${raw.slice(3).join("/")}${wire.url.search}`;
    // `serve` re-checks can(viewer) against live rows BEFORE any machine work,
    // so a revoked viewer's next request is refused even though what their
    // session already rendered stands.
    const payload = await payloadOf(request, request.method, inner);
    return relayAnswer(await deps.apps.serve(appId, payload, ctx));
  }),
];

export const fnProxyRoutes: RouteEntry[] = [
  route("POST", "/apps/:appId/fn/:name", async ({ request, params, deps, context }) => {
    const appId = string(params["appId"], "app id");
    const name = params["name"] ?? "";
    if (!FN_NAME_PATTERN.test(name)) {
      throw new VendoError("validation", "fn name must match [A-Za-z_][A-Za-z0-9_-]{0,63}");
    }
    const ctx = await context("app");
    // Existence-masking BEFORE any machine work: `get` is viewer-scoped, so a
    // caller who cannot even see the app is told it isn't there rather than
    // being refused a box. The box door itself then requires editor.
    if (await deps.apps.get(appId, ctx) === null) {
      throw new VendoError("not-found", `app not found: ${appId}`);
    }
    // The box's authority is its own app token, nothing more.
    const payload = await payloadOf(request, "POST", `/fn/${name}`);
    const work = deps.apps.box.request(appId, payload, ctx);
    const answer = await withTimeout(work, FN_TIMEOUT_MS);
    if (answer === TIMED_OUT) {
      // The box keeps working; only this wire request gives up. Swallow the
      // eventual settle so a late failure never surfaces as unhandled.
      work.catch(() => undefined);
      return json({ error: { code: "timeout", message: `fn ${name} did not answer within ${FN_TIMEOUT_MS}ms` } }, 504);
    }
    return relayAnswer(answer);
  }),
];

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

function requireJson(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new VendoError("validation", "content-type must be application/json");
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new VendoError("validation", "request body exceeds size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new VendoError("validation", "request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new VendoError("validation", "request body must be an object");
  }
  return parsed as Record<string, unknown>;
}

/** The list query the rows surface accepts (mirrors the v1 proxy dialect). */
function rowsQuery(url: URL): RecordQuery {
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
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new VendoError("validation", "limit must be a positive integer");
      }
      limit = Number(value);
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
}

async function handleRows(wire: WireContext, appId: string, owner: string): Promise<Response | undefined> {
  const { request, url, segments, deps } = wire;
  const collection = segments[2];
  if (collection === undefined || !COLLECTION_PATTERN.test(collection)) {
    throw new VendoError("validation", "rows collection must match [A-Za-z0-9_-]{1,64}");
  }
  // The appData family is optional on StoreOps, so "no ops surface" and "an ops
  // surface that omits app rows" are the same answer here: this door is nothing
  // but app rows.
  const rows = deps.ops?.appData;
  if (rows === undefined) {
    throw new VendoError(
      "not-implemented",
      "A box row is owner-stamped app data, so this door needs the store's appData family: "
      + "it needs a SQL-backed store (`store: postgres(url)`, or the local default) or a "
      + "StoreOps-capable store (the Cloud hosted store). The configured store is neither.",
    );
  }
  // The app-scoped, owner-scoped drawer: the box: infix keeps box rows apart
  // from the host-declared v1 storage collections sharing the app:<id> prefix,
  // and the owner is the app token's subject — stamped here, on the box's
  // behalf, because the box is never told who the user is.
  const target = { appId, collection: `box:${collection}`, owner };

  // Lane E redaction guard — nothing a box writes or reads through this door
  // may carry a known secret value into a store row or a response body.
  const scrub = <T>(value: T): Promise<T> =>
    deps.apps.box.redact(appId, value as Json) as Promise<T>;

  if (segments.length === 3) {
    if (request.method !== "GET") return undefined;
    return json(await scrub(await rows.list(target, rowsQuery(url))));
  }
  if (segments.length !== 4) return undefined;
  const id = segments[3]!;
  if (id.length === 0 || id.length > 256) {
    throw new VendoError("validation", "row id must be 1-256 characters");
  }
  if (request.method === "GET") {
    const record = await rows.get(target, id);
    if (record === null) throw new VendoError("not-found", `row not found: ${id}`);
    return json(await scrub(record));
  }
  if (request.method === "DELETE") {
    await rows.delete(target, id);
    return json({ status: "ok" });
  }
  if (request.method === "PUT") {
    requireJson(request);
    const body = await readBoundedJson(request, ROW_MAX_BYTES);
    const unexpected = Object.keys(body).find((key) => key !== "data" && key !== "refs");
    if (unexpected !== undefined) {
      throw new VendoError("validation", `unexpected row property: ${unexpected}`);
    }
    if (!Object.prototype.hasOwnProperty.call(body, "data")) {
      throw new VendoError("validation", "row body must contain data");
    }
    if (body["refs"] !== undefined) {
      const refs = body["refs"];
      if (typeof refs !== "object" || refs === null || Array.isArray(refs)
        || Object.values(refs).some((value) => typeof value !== "string" || value === "")) {
        throw new VendoError("validation", "row refs must be an object of non-empty strings");
      }
    }
    // Scrub BEFORE persisting: a secret value must never land in a store row,
    // even when the box itself sent it.
    return json(await rows.put(target, await scrub({
      id,
      data: body["data"] as Json,
      ...(body["refs"] === undefined ? {} : { refs: body["refs"] as Record<string, string> }),
    })));
  }
  return undefined;
}

async function handleTools(wire: WireContext, ctx: RunContext): Promise<Response | undefined> {
  const { request, segments, deps } = wire;
  if (request.method !== "POST" || segments.length !== 3) return undefined;
  const name = segments[2]!;
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new VendoError("validation", "tool name must match [a-zA-Z0-9_-]{1,64}");
  }
  requireJson(request);
  const body = await readBoundedJson(request, ROW_MAX_BYTES);
  const args = body["args"];
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new VendoError("validation", "tool body must be an object containing an args object");
  }
  // The SAME guard-bound registry every venue executes through: policy,
  // grants, approvals, breakers, and audit all see this call. An ask-policy
  // tool comes back { status: "pending-approval" } — relayed, never bypassed.
  const outcome = await deps.tools.execute({
    id: `call_${globalThis.crypto.randomUUID()}`,
    tool: name,
    args: args as Json,
  }, ctx);
  // Lane E redaction guard — a tool outcome relayed into a response is a
  // host-side artifact; scrub known secret values before it crosses back.
  return json(await deps.apps.box.redact(ctx.appId ?? "", outcome as Json));
}

export const boxRoutes: RouteEntry[] = [
  prefixRoute("*", "/box/", async (wire) => {
    const { request, segments, deps } = wire;
    // The bearer IS the identity: the per-app token minted at provision, its
    // hash row the authority (createAppTokens). No cookie, no host principal —
    // this surface is called from inside the box, in any language, via curl.
    const presented = bearerToken(request);
    const identity = presented === null ? null : await deps.appTokens.verify(presented);
    if (identity === null) {
      return json({ error: { code: "blocked", message: "invalid app token" } }, 401);
    }
    // The box acts AS the app's owner, away, in the app venue — exactly the
    // authority a tree action carries when the owner isn't looking at it.
    const ctx: RunContext = {
      principal: { kind: "user", subject: identity.subject },
      venue: "app",
      presence: "away",
      sessionId: `box_${identity.appId}`,
      appId: identity.appId,
    };
    // A deleted (or re-owned) app retires its token even before revocation.
    if (await deps.apps.get(identity.appId, ctx) === null) {
      return json({ error: { code: "blocked", message: "app token no longer valid" } }, 401);
    }
    const area = segments[1];
    if (area === "rows") {
      const handled = await handleRows(wire, identity.appId, identity.subject);
      if (handled !== undefined) return handled;
    }
    if (area === "tools") {
      const handled = await handleTools(wire, ctx);
      if (handled !== undefined) return handled;
    }
    throw new VendoError("not-found", "unknown box route");
  }),
];
