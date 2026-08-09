import { VendoError } from "@vendoai/core";
import { computeImpact } from "../sync-impact.js";
import {
  VERSION,
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

/** Length-independent-leak-free digest compare for timingSafeEqual's HMAC
    digests (always equal-length hex; unequal lengths simply fail). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
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
    development flag, so these answer the ordinary 404 — there is no
    guarded-but-mounted production endpoint. */
export const devRoutes: RouteEntry[] = [
  // 06-apps §9 — the documented LOCAL injection seam for in-client approval
  // records (demos and dev; Cloud's review console mints these in
  // production). Development compositions only: production handlers fall
  // through to the ordinary 404, so no production surface can self-approve
  // an app into the host page. For a REVIEW-KIND remix the runtime refuses
  // the app's own user even here (round-2 hardening): approval IS the
  // review, so it takes the composition's reviewer assertion
  // (apps.review.reviewer) — which also lets an asserted reviewer approve
  // across the owner boundary.
  route("POST", "/dev/inclient-approval", async ({ request, deps, context }) => {
    if (!deps.development) return undefined;
    const body = await requestJson(request);
    // Approving a host-page mount is a HOST trust decision — an ephemeral
    // principal is not enough, even in dev.
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

/** External-event ingress. Mounted with the automations subsystem, and absent
    without it — a delivery to a deployment that does not run automations is a
    404 rather than a door that accepts the event and drops it. */
export const webhookRoutes: RouteEntry[] = [
  prefixRoute("POST", "/webhooks/", async ({ request, deps }) => {
    return await deps.automations.webhook(request);
  }),
];

/** The machine-facing surface: the authenticated scheduler tick. Matches on the
    RAW path ahead of any segment decoding, exactly like the old chain. The tick
    is here rather than with the webhook door because it also drives the hosted
    session sweep, which every deployment needs. (The v1 run-token apps proxy
    mount died with execution-v2 Wave 1.5; the box callback surface at /box/ is
    its replacement.) */
export const systemRoutes: RouteEntry[] = [
  route("POST", "/tick", async ({ request, deps, sweep }) => {
    if (!await tickAuthorized(request)) {
      return json({ error: { code: "blocked", message: "invalid tick credential" } }, 401);
    }
    // One authenticated tick drives the ONE scheduler — the automations engine,
    // which fires every trigger including the schedules a machine app declares
    // in its vendo.json (folded into doc triggers at manifest sync) — plus the
    // hosted TTL sweep (sweepOnTick). Point any external cron here (Vercel cron,
    // GitHub Actions, crontab); the Cloud broker calls this same surface. The
    // legs settle independently so one failing can never suppress the other; any
    // failure still answers 500 so a retrying cron comes back (both are
    // idempotent within their windows).
    const [runs, sessions] = await Promise.allSettled([
      deps.automations.tick(),
      deps.sweepOnTick ? sweep() : Promise.resolve(),
    ]);
    const errors = [
      ...(runs.status === "rejected" ? [`automations: ${runs.reason instanceof Error ? runs.reason.message : "tick failed"}`] : []),
      ...(sessions.status === "rejected" ? [`sessions: ${sessions.reason instanceof Error ? sessions.reason.message : "sweep failed"}`] : []),
    ];
    return json({
      ...(runs.status === "fulfilled" ? { runIds: runs.value } : {}),
      ...(errors.length === 0 ? {} : { errors }),
    }, errors.length === 0 ? 200 : 500);
  }),
];

/** The `vendo sync` blast-radius probe, mounted ONLY in a development
    composition (wireRoutesFor) — a deployment that did not opt in has no such
    route and answers the ordinary 404.

    It used to sit in systemRoutes and refuse per-request on
    `environment("NODE_ENV") === "production"`, which failed OPEN twice over:
    `environment()` answers undefined for an unset NODE_ENV and on any runtime
    without a `process` global (edge, Workers). Either one served this to an
    anonymous caller — and the answer is not scoped to a principal, it reads
    the deployment's whole vendo_apps and vendo_grants collections, so it was
    cross-subject enumeration. Absence of configuration has to mean closed;
    `deps.development` is the flag that already means that, and it is decided at
    boot rather than per request. */
export const syncImpactRoutes: RouteEntry[] = [
  route("POST", "/sync/impact", async ({ request, deps }) => {
    const body = await requestJson(request);
    const tools = body["tools"];
    if (!Array.isArray(tools) || tools.length > 200 || tools.some((tool) => typeof tool !== "string")) {
      throw new VendoError("validation", "tools must be an array of at most 200 strings");
    }
    return json({ impact: await computeImpact(deps.store, tools) });
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
];

export const statusRoutes: RouteEntry[] = [
  route("GET", "/status", async ({ deps, context }) => {
    const ctx = await context("chat");
    return json({
      posture: deps.guard.status().posture,
      version: VERSION,
      // Build contract §9.1 — the orgs the host ASSERTED for this caller, so
      // the Share dialog can offer them by name. Nothing is stored: this is
      // the same per-request answer `can()` just used, echoed to the surface.
      ...(ctx.memberships === undefined ? {} : { memberships: ctx.memberships }),
      // Build contract §9.1 companion — can the HOST name a person from what
      // someone types? Vendo holds no directory, so with the `resolvePerson`
      // seam unset the Share dialog must not offer to share with one person at
      // all: it used to, and encoded whatever was typed as the subject.
      ...(deps.resolvePerson === undefined ? {} : { namesPeople: true }),
      blocks: {
        store: true,
        agent: true,
        actions: true,
        guard: true,
        apps: true,
        automations: true,
        sandbox: deps.sandbox,
        // Inference seam (cloud definition 2026-07-17): "custom" (host-passed
        // model) or "ladder" (the composed vendoModel env default).
        model: deps.model,
        // 10-mcp §1 + the broker seam: false while the door
        // is closed (it is off by default); "local" when the open door serves
        // its own OAuth surface; "broker" when an external authorization
        // server fronts it.
        mcp: deps.mcp,
        // 04-actions §3 — how per-user connected accounts are brokered:
        // "byo" (host's own Composio key), "cloud" (VENDO_API_KEY), or off.
        connections: deps.connections.posture,
      },
    });
  }),
];
