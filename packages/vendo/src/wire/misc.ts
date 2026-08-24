import { signedWebhookBytes, verifySignature } from "@vendoai/automations";
import { log, VendoError } from "@vendoai/core";
import { computeImpact } from "../sync-impact.js";
import { tickSecret } from "../tick-enrolment.js";
import {
  VERSION,
  hex,
  json,
  orgsCloudRequired,
  prefixRoute,
  requestJson,
  route,
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
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await compareKey();
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  return constantTimeEqual(hex(da), hex(db));
}

/** How far a signed heartbeat's clock may be from this one (standard-webhooks'
    own recommendation). Wide enough for a queue retry, narrow enough that a
    captured signature is not a permanent key. */
const TICK_SIGNATURE_WINDOW_MS = 300_000;

/** A standard-webhooks signature over the EMPTY body — what Vendo Cloud's
    heartbeat sends. The signed bytes are `${webhook-id}.${webhook-timestamp}.`
    and nothing else, so this door never reads a body it would then ignore.

    Verification is the ENGINE's own `verifySignature`, not a second copy of the
    scheme: the secret is base64url and has to be DECODED before the HMAC, and a
    door that keyed on the text's characters instead would answer 401 to every
    signed knock forever while agreeing perfectly with its own restatement. The
    bearer above compares the same env var as a STRING — one secret, read as the
    credential each waker presents, which is also why a host who chose a
    passphrase rather than base64url still gets a working bearer and simply never
    matches on this leg. */
async function tickSignatureValid(request: Request, secret: string): Promise<boolean> {
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const header = request.headers.get("webhook-signature");
  if (id === null || timestamp === null || header === null || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(Date.now() - Number(timestamp) * 1_000) > TICK_SIGNATURE_WINDOW_MS) return false;
  const signed = signedWebhookBytes(id, timestamp, new Uint8Array());
  // Senders may present several space-separated candidates during a key
  // rotation: the delivery is good if ANY v1 candidate verifies.
  for (const candidate of header.split(/\s+/)) {
    if (!candidate.startsWith("v1,")) continue;
    if (await verifySignature(secret, candidate.slice(3), signed)) return true;
  }
  return false;
}

/** The two credentials the ONE wake endpoint takes, side by side and against
    the SAME secret: the host's own `Bearer $VENDO_TICK_SECRET` (a Vercel cron,
    a GitHub Action, crontab) and a standard-webhooks signature (Vendo Cloud's
    heartbeat). A deployment configures one thing — or, with a Cloud key, nothing
    at all: `tickSecret` derives the secret enrolment published (tick-enrolment.ts)
    and VENDO_TICK_SECRET stays the BYO override that wins. Either waker works. */
async function tickAuthorized(request: Request): Promise<boolean> {
  const secret = await tickSecret();
  if (secret === undefined) return false;
  return await timingSafeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)
    || await tickSignatureValid(request, secret);
}

/** External-event ingress. Mounted with the automations subsystem, and absent
    without it — a delivery to a deployment that does not run automations is a
    404 rather than a door that accepts the event and drops it. */
export const webhookRoutes: RouteEntry[] = [
  prefixRoute("POST", "/webhooks/", async ({ request, deps }) => {
    return await deps.automations.webhook(request);
  }),
];

/** THE firing door, and the only wake endpoint there is. Matches on the RAW
    path ahead of any segment decoding, exactly like the old chain. It lives
    here rather than with the webhook door because it also drives the hosted
    session sweep, which every deployment needs. (The v1 run-token apps proxy
    mount died with execution-v2 Wave 1.5; the box callback surface at /box/ is
    its replacement.)

    Three wakers knock on it and none of them holds a schedule: the host's own
    cron, the dev ticker, and Vendo Cloud's heartbeat. The ENGINE decides what
    is due, and its claim is atomic — so the door is idempotent, and a duplicate
    knock honestly answers `{ fired: 0 }`. */
export const systemRoutes: RouteEntry[] = [
  route("POST", "/tick", async ({ request, deps, sweep }) => {
    if (!await tickAuthorized(request)) {
      return json({
        error: {
          code: "blocked",
          message: "POST /api/vendo/tick needs a credential and this request carried none that verified. "
            + "Send either `Authorization: Bearer $VENDO_TICK_SECRET`, or a standard-webhooks signature "
            + "(webhook-id, webhook-timestamp, webhook-signature) over the empty body, signed with that same secret. "
            + "If this deployment has no secret at all: set VENDO_API_KEY and Vendo Cloud's heartbeat wakes it with "
            + "nothing further to configure, or set VENDO_TICK_SECRET and point your own cron here.",
        },
      }, 401);
    }
    // Two legs, settled independently. The sweep is HOUSEKEEPING that rides the
    // same cadence; it must not be able to change the automations answer, so a
    // failing sweep is logged for the operator and the tick still reports what
    // it fired. (It used to 500 the whole call, which told a heartbeat the
    // deployment was down when its automations had just run fine.)
    const [runs, sessions] = await Promise.allSettled([
      deps.automations.tick(),
      deps.sweepOnTick ? sweep() : Promise.resolve(),
    ]);
    if (sessions.status === "rejected") {
      log({
        code: "vendo.tick-sweep-failed",
        level: "warn",
        message: "[vendo] the hosted session sweep failed on this tick; automations were unaffected: "
          + `${sessions.reason instanceof Error ? sessions.reason.message : String(sessions.reason)}`,
      });
    }
    if (runs.status === "rejected") {
      throw new VendoError(
        "unavailable",
        `the automations tick failed: ${runs.reason instanceof Error ? runs.reason.message : String(runs.reason)}. `
        + "Call it again — the tick is idempotent, so nothing it already claimed re-fires.",
      );
    }
    return json({ fired: runs.value.length }, 202);
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
    return json({ impact: await computeImpact(deps.ops, tools) });
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
      // Build contract §9.1 — the orgs the host ASSERTED for this caller, so a
      // surface can name them. Nothing is stored: this is the same per-request
      // answer `can()` just used, echoed to the surface.
      ...(ctx.memberships === undefined ? {} : { memberships: ctx.memberships }),
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
