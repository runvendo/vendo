import { VendoError, principalSchema, type Principal, type ToolOutcome } from "@vendoai/core";
import { computeImpact } from "../sync-impact.js";
import {
  VERSION,
  constantTimeEqual,
  environment,
  hex,
  json,
  orgsCloudRequired,
  prefixRoute,
  requestJson,
  route,
  string,
  type RouteEntry,
} from "./shared.js";

const DOCTOR_PRESENT_AUTHORIZATION = "Bearer vendo-doctor-present";
const DOCTOR_PRESENT_COOKIE = "vendo_doctor_present=1";
export const DOCTOR_ACT_AS_PRINCIPAL: Principal = { kind: "user", subject: "vendo_doctor_act_as" };

function doctorProbeOk(outcome: ToolOutcome): boolean {
  if (outcome.status !== "ok" || typeof outcome.output !== "object" || outcome.output === null) return false;
  return "ok" in outcome.output && outcome.output.ok === true;
}

/** Lazily-minted random per-process HMAC key for constant-time secret compares
    (WebCrypto only — NO node:crypto — so the module keeps bundling for edge/
    Worker targets; cf. dotVendoFile). */
let compareKeyPromise: Promise<CryptoKey> | undefined;
function compareKey(): Promise<CryptoKey> {
  compareKeyPromise ??= (() => {
    const raw = new Uint8Array(32);
    globalThis.crypto.getRandomValues(raw);
    return globalThis.crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  })();
  return compareKeyPromise;
}

/** Constant-time string equality via WebCrypto, matching the webhook HMAC path
    (which leans on crypto.subtle.verify for the same guarantee). HMACs both
    inputs under a random per-process key so the digests are equal-length 32-byte
    values regardless of input length — equal digests iff equal inputs (SHA-256
    collision resistance) — and the byte compare leaks neither length nor content
    through timing. Replaces the `===` bearer compare, a classic timing oracle. */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await compareKey();
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  return constantTimeEqual(hex(da), hex(db));
}

async function tickAuthorized(request: Request): Promise<boolean> {
  const secret = environment("VENDO_TICK_SECRET");
  if (secret === undefined) return false;
  return timingSafeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

/** The development-only injection seams. Each handler guards on its composed
    dependency and falls through otherwise: production handlers receive no
    runtimeCapture dependency / no development flag, so these answer the
    ordinary 404 — there is no guarded-but-mounted production endpoint. */
export const devRoutes: RouteEntry[] = [
  route("POST", "/dev/remixable-source", async ({ request, deps, context }) => {
    if (deps.runtimeCapture === undefined) return undefined;
    const body = await requestJson(request);
    // Capture writes .vendo/remixable baselines on the developer's disk, so
    // it requires a HOST-resolved principal — an anonymous visitor's minted
    // ephemeral session is not enough, even in a development composition.
    const captureContext = await context("app");
    if (captureContext.principal.ephemeral === true) {
      return json({ error: { code: "blocked", message: "runtime capture requires a host-resolved principal" } }, 401);
    }
    if (typeof body["exportable"] !== "boolean") {
      throw new VendoError("validation", "exportable must be a boolean");
    }
    return json(await deps.runtimeCapture.capture({
      slot: string(body["slot"], "slot"),
      source: string(body["source"], "source"),
      exportable: body["exportable"],
    }));
  }),
  // 06-apps §9 — the documented LOCAL injection seam for in-client approval
  // records (demos and dev; Cloud's review console mints these in
  // production). Development compositions only: production handlers fall
  // through to the ordinary 404, exactly like /dev/remixable-source, so no
  // production surface can self-approve an app into the host page.
  route("POST", "/dev/inclient-approval", async ({ request, deps, context }) => {
    if (!deps.development) return undefined;
    const body = await requestJson(request);
    // Approving a host-page mount is a HOST trust decision — an anonymous
    // visitor's minted ephemeral session is not enough, even in dev.
    const approvalContext = await context("app");
    if (approvalContext.principal.ephemeral === true) {
      return json({ error: { code: "blocked", message: "in-client approval injection requires a host-resolved principal" } }, 401);
    }
    const approvedBy = body["approvedBy"] === undefined
      ? "local-dev"
      : string(body["approvedBy"], "approvedBy");
    return json(await deps.apps.inClient.approve({
      appId: string(body["appId"], "appId"),
      approvedBy,
    }, approvalContext));
  }),
];

/** Doctor targets a running dev server. The prefix gate keeps its synthetic
    mint/echo routes out of production entirely (and falls through in
    development); the echo halves expose no credential material — booleans
    only. */
export const doctorRoutes: RouteEntry[] = [
  prefixRoute("*", "/doctor/", async () => {
    if (environment("NODE_ENV") === "production") {
      throw new VendoError("not-found", "unknown Vendo route");
    }
    return undefined;
  }),
  route("GET", "/doctor/present/echo", async ({ request }) => {
    return json({
      ok: request.headers.get("authorization") === DOCTOR_PRESENT_AUTHORIZATION
        && request.headers.get("cookie") === DOCTOR_PRESENT_COOKIE,
    });
  }),
  route("GET", "/doctor/act-as/echo", async ({ request, deps }) => {
    const resolved = await deps.principal(request);
    const parsed = principalSchema.safeParse(resolved);
    const accepted = parsed.success && parsed.data.subject === DOCTOR_ACT_AS_PRINCIPAL.subject;
    return json({ ok: accepted }, accepted ? 200 : 401);
  }),
  route("POST", "/doctor/present", async ({ deps, context }) => {
    const outcome = await deps.doctor.present(await context("chat"));
    if (doctorProbeOk(outcome)) return json({ ok: true });
    return json({
      ok: false,
      error: {
        code: "present-credentials-not-forwarded",
        message: "Present credentials did not reach the host API. Set VENDO_BASE_URL to the running host origin and restart the dev server.",
      },
    }, 409);
  }),
  route("POST", "/doctor/act-as", async ({ deps }) => {
    const outcome = await deps.doctor.actAs();
    if (doctorProbeOk(outcome)) return json({ ok: true });
    if (outcome.status === "error" && outcome.error.code === "not-implemented") {
      return json({
        ok: false,
        error: {
          code: "act-as-not-configured",
          message: "actAs is not configured; pass createVendo({ actAs }) before enabling away host actions.",
        },
      }, 501);
    }
    return json({
      ok: false,
      error: {
        code: "act-as-verification-failed",
        message: "actAs returned no usable AuthMaterial, or the host API did not accept it. Check the matching verifier middleware and principal resolver.",
      },
    }, 409);
  }),
];

/** The machine-facing surfaces: webhook ingress, the authenticated scheduler
    tick, the dev-only sync impact probe, and the apps proxy mount. All match
    on the RAW path (prefix or exact) ahead of any segment decoding, exactly
    like the old chain. */
export const systemRoutes: RouteEntry[] = [
  prefixRoute("POST", "/webhooks/", async ({ request, deps }) => {
    return await deps.automations.webhook(request);
  }),
  route("POST", "/tick", async ({ request, deps }) => {
    if (!await tickAuthorized(request)) {
      return json({ error: { code: "blocked", message: "invalid tick credential" } }, 401);
    }
    return json({ runIds: await deps.automations.tick() });
  }),
  route("POST", "/sync/impact", async ({ request, deps }) => {
    if (process.env.NODE_ENV === "production") {
      throw new VendoError("blocked", "sync impact is only available on a dev server");
    }
    const body = await requestJson(request);
    const tools = body["tools"];
    if (!Array.isArray(tools) || tools.length > 200 || tools.some((tool) => typeof tool !== "string")) {
      throw new VendoError("validation", "tools must be an array of at most 200 strings");
    }
    return json({ impact: await computeImpact(deps.store, tools) });
  }),
  prefixRoute("*", "/proxy/", async ({ request, path, deps }) => {
    const proxyPath = path.slice("/proxy".length);
    const proxyUrl = new URL(request.url);
    proxyUrl.pathname = proxyPath;
    return await deps.apps.proxy.handler(new Request(proxyUrl, request));
  }),
];

/** The decoded first segment matches only /orgs and /orgs/* (any depth, any
    method), never a lookalike like /organizations; the rest wildcard also
    covers a trailing-slash `/orgs/`. */
export const orgsRoutes: RouteEntry[] = [
  route("*", "/orgs/*", async () => orgsCloudRequired()),
];

export const activityRoutes: RouteEntry[] = [
  route("GET", "/activity", async ({ url, deps, context }) => {
    const ctx = await context("chat");
    const limitValue = url.searchParams.get("limit");
    const limit = limitValue === null ? undefined : Number(limitValue);
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      throw new VendoError("validation", "activity limit must be a positive integer");
    }
    const activity = await deps.guard.audit.query({
      principal: ctx.principal,
      ...(url.searchParams.get("cursor") === null ? {} : { cursor: url.searchParams.get("cursor")! }),
      ...(limit === undefined ? {} : { limit }),
    });
    // 09 §3: the wire returns AuditEvent[] — the block's {events,cursor}
    // envelope stays internal (the client pages by last event id).
    return json(activity.events);
  }),
  route("GET", "/status", async ({ deps, context }) => {
    await context("chat");
    return json({
      posture: deps.guard.status().posture,
      version: VERSION,
      blocks: {
        store: true,
        agent: true,
        actions: true,
        guard: true,
        apps: true,
        automations: true,
        sandbox: deps.sandbox,
        // 10-mcp §1 — the door is off by default; true only when
        // createVendo({ mcp: true }) opened it.
        mcp: deps.mcp,
        // 04-actions §3 — how per-user connected accounts are brokered:
        // "byo" (host's own Composio key), "cloud" (VENDO_API_KEY), or off.
        connections: deps.connections.posture,
      },
    });
  }),
];
