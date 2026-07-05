/**
 * POST /webhooks/composio — signature-verified Composio trigger ingress
 * (single-tenant v1; no host `principal` guard — the signature IS the auth).
 *
 * RESEARCH PIN (2026-07-04, no live Composio capture available at
 * implementation time — see the plan's Task 13 note). Composio delivers
 * triggers as Svix-compatible webhooks (the "standard webhooks" convention
 * also used by Svix, Resend, Clerk, etc.):
 *
 *   Headers (all required):
 *     webhook-id        — the delivery id. Doubles as our dedup `eventId`
 *                          (TriggerEnvelope.eventId): a redelivery of the same
 *                          event reuses the same id, and the runner's
 *                          deterministic run id (automationId::source::eventId)
 *                          turns that into a no-op via DuplicateRunError.
 *     webhook-timestamp — Unix seconds the message was sent. Rejected if it
 *                          drifts more than 5 minutes from "now" in EITHER
 *                          direction (replay protection).
 *     webhook-signature — space-separated "v1,<base64 hmac>" values (Svix
 *                          signs with multiple secrets during a rotation; we
 *                          only ever hold one configured secret, but tolerate
 *                          multiple space-separated candidates).
 *
 *   Signing: HMAC-SHA256 over the ASCII string `${id}.${timestamp}.${body}`
 *   (body = the RAW, unparsed request bytes — this is why `req.text()` is
 *   read before any JSON.parse). Compared with `timingSafeEqual`.
 *
 *   KEY AMBIGUITY: the docs disagree on what keys the HMAC. The Svix
 *   convention (which Composio's whsec_ prefix suggests) strips `whsec_` and
 *   BASE64-DECODES the rest; Composio's own webhook docs show the HMAC keyed
 *   by the RAW secret string. With no live capture available to pin the
 *   contract, verification is TOLERANT: it computes an expected HMAC with
 *   BOTH keys (raw secret bytes, and the base64-decoded whsec_-stripped
 *   value) and accepts if ANY v1 candidate matches either — constant-time
 *   per compare. Release-time drill item: capture a real delivery and pin
 *   this down to the single correct key.
 *
 *   Env: `COMPOSIO_WEBHOOK_SECRET` (the `whsec_`-prefixed value verbatim).
 *   Missing entirely → 404 (fail closed: there is no way to authenticate a
 *   request, so the endpoint must not exist rather than accept everything).
 *
 * `verifyComposioSignature` is the ONLY function that encodes this contract.
 * If a real captured payload at drill/integration time reveals a different
 * header name, algorithm, or envelope, this is a one-function fix — nothing
 * else in this file (or its caller) needs to change.
 *
 * TRIGGER PAYLOAD ENVELOPE: Composio's trigger payload shape is likewise not
 * pinned from a live capture, so `extractTriggerEnvelope` is deliberately
 * tolerant: it looks for the trigger slug and connected-account id under
 * several common spellings (`trigger_slug`/`triggerSlug`/`type`,
 * `connected_account_id`/`connectedAccountId`), checking both the payload
 * root and a nested `data`/`payload` envelope (most webhook senders, Composio
 * included, wrap the actual event under one of those keys). A payload that
 * doesn't yield both fields under any of these spellings takes the 400 path.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ConnectionsStore } from "./connections";
import type { FlowletAutomationsWorld } from "./world";

export interface ComposioWebhookDeps {
  /** The embedded automations world (null when `automations: false`). */
  world: FlowletAutomationsWorld | null;
  connections: ConnectionsStore;
  /** Injectable for tests; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Injectable clock for signature timestamp-tolerance tests. */
  nowMs?: () => number;
}

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

let warnedMissingSecret = false;

function resolveSecret(env: Record<string, string | undefined>): string | undefined {
  return env["COMPOSIO_WEBHOOK_SECRET"] || undefined;
}

function warnMissingSecretOnce(): void {
  if (warnedMissingSecret) return;
  warnedMissingSecret = true;
  console.warn(
    "[flowlet] COMPOSIO_WEBHOOK_SECRET is not set — POST webhooks/composio will 404 until " +
      "it is configured (the signing secret from the Composio dashboard's webhook settings).",
  );
}

/**
 * The isolated verify step (see the file header for the exact contract).
 * Returns false for any malformed input as well as a genuine mismatch —
 * callers only need to know whether the request may be trusted.
 */
export function verifyComposioSignature(input: {
  id: string;
  timestamp: string;
  signature: string;
  body: string;
  secret: string;
  nowMs?: number;
  toleranceMs?: number;
}): boolean {
  const tsSeconds = Number(input.timestamp);
  if (!Number.isFinite(tsSeconds)) return false;
  const nowMs = input.nowMs ?? Date.now();
  const toleranceMs = input.toleranceMs ?? TIMESTAMP_TOLERANCE_MS;
  if (Math.abs(nowMs - tsSeconds * 1000) > toleranceMs) return false;

  // Tolerant key derivation (see the file header's KEY AMBIGUITY note):
  // both the raw secret bytes (Composio-docs convention) and the
  // base64-decoded whsec_-stripped value (Svix convention) are tried.
  const keys: Buffer[] = [];
  const rawKey = Buffer.from(input.secret, "utf8");
  if (rawKey.length > 0) keys.push(rawKey);
  const secretB64 = input.secret.startsWith("whsec_") ? input.secret.slice("whsec_".length) : input.secret;
  try {
    const decoded = Buffer.from(secretB64, "base64");
    if (decoded.length > 0) keys.push(decoded);
  } catch {
    // Not base64 — the raw-key candidate still applies.
  }
  if (keys.length === 0) return false;

  const message = `${input.id}.${input.timestamp}.${input.body}`;
  const expected = keys.map((key) =>
    Buffer.from(createHmac("sha256", key).update(message).digest("base64"), "base64"),
  );

  for (const candidate of input.signature.split(" ")) {
    const [version, sig] = candidate.split(",");
    if (version !== "v1" || !sig) continue;
    let candidateBytes: Buffer;
    try {
      candidateBytes = Buffer.from(sig, "base64");
    } catch {
      continue;
    }
    for (const expectedBytes of expected) {
      if (candidateBytes.length === expectedBytes.length && timingSafeEqual(candidateBytes, expectedBytes)) {
        return true;
      }
    }
  }
  return false;
}

interface ExtractedTrigger {
  triggerSlug: string;
  connectedAccountId: string;
}

function pickString(obj: unknown, keys: string[]): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const record = obj as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const TRIGGER_SLUG_KEYS = ["trigger_slug", "triggerSlug", "type"];
// Composio V3 metadata: only EXPLICIT slug spellings — never `type`, which in
// a V3 envelope is a generic event type (e.g. "trigger.fired"), not the slug.
const METADATA_TRIGGER_SLUG_KEYS = ["trigger_slug", "triggerSlug"];
const CONNECTED_ACCOUNT_KEYS = ["connected_account_id", "connectedAccountId"];

/** Tolerant extractor — see the file header's payload-envelope note.
 *  Composio V3 puts `trigger_slug` and `connected_account_id` under a
 *  `metadata` envelope (at the root or nested inside `data`) while the root
 *  `type` is a generic event type — so metadata is consulted FIRST, before
 *  the root/nested fallbacks that older shapes use. */
function extractTriggerEnvelope(payload: unknown): ExtractedTrigger | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const root = payload as Record<string, unknown>;
  const nested = root["data"] ?? root["payload"];
  const metadata =
    root["metadata"] ??
    (typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)["metadata"]
      : undefined);

  const triggerSlug =
    pickString(metadata, METADATA_TRIGGER_SLUG_KEYS) ??
    pickString(root, TRIGGER_SLUG_KEYS) ??
    pickString(nested, TRIGGER_SLUG_KEYS);
  const connectedAccountId =
    pickString(metadata, CONNECTED_ACCOUNT_KEYS) ??
    pickString(root, CONNECTED_ACCOUNT_KEYS) ??
    pickString(nested, CONNECTED_ACCOUNT_KEYS);
  if (!triggerSlug || !connectedAccountId) return undefined;
  return { triggerSlug, connectedAccountId };
}

export async function handleComposioWebhook(req: Request, deps: ComposioWebhookDeps): Promise<Response> {
  const env = deps.env ?? process.env;
  const secret = resolveSecret(env);
  if (!secret) {
    warnMissingSecretOnce();
    return Response.json({ error: "composio webhooks are not configured" }, { status: 404 });
  }
  if (!deps.world) {
    return Response.json({ error: "automations are disabled" }, { status: 404 });
  }

  // Raw bytes BEFORE any parsing — the HMAC is over the exact wire body.
  const raw = await req.text();
  const id = req.headers.get("webhook-id");
  const timestamp = req.headers.get("webhook-timestamp");
  const signature = req.headers.get("webhook-signature");
  if (
    !id ||
    !timestamp ||
    !signature ||
    !verifyComposioSignature({ id, timestamp, signature, body: raw, secret, nowMs: deps.nowMs?.() })
  ) {
    return Response.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.error("[flowlet] composio webhook: malformed JSON payload", err);
    return Response.json({ error: "malformed payload" }, { status: 400 });
  }

  const extracted = extractTriggerEnvelope(payload);
  if (!extracted) {
    console.error("[flowlet] composio webhook: unrecognized trigger payload shape");
    return Response.json({ error: "unrecognized payload shape" }, { status: 400 });
  }

  const owner = await deps.connections.findByConnectedAccount(extracted.connectedAccountId);
  if (!owner) {
    return Response.json({ skipped: true });
  }

  const matches = await deps.world.store.findEnabledByTrigger(owner.principal, {
    kind: "composio",
    key: extracted.triggerSlug,
  });

  const occurredAt = new Date(tsSecondsToMs(timestamp)).toISOString();
  for (const automation of matches) {
    // A redelivery's DuplicateRunError is swallowed INSIDE runner.fire itself
    // (see runner.ts fireNow) — nothing to catch here.
    await deps.world.runner.fire(owner.principal, automation.id, {
      source: "composio",
      eventId: id,
      subject: owner.principal.subject,
      occurredAt,
      payload,
    });
  }

  return Response.json({ ok: true, fired: matches.length });
}

// `timestamp` was already validated as finite by verifyComposioSignature.
function tsSecondsToMs(timestamp: string): number {
  return Number(timestamp) * 1000;
}
