import { VendoError, defaultFetch, type Principal } from "@vendoai/core";
import { consoleSender, raiseCloudError } from "./cloud-console.js";
import { hex } from "./wire/shared.js";

/** The TEXT CHANNEL seam: a deployment's users reach the agent over
 * iMessage/SMS. Conversations only — text in, the agent acts as the linked
 * user, text back.
 *
 * The deployment never talks to the messaging vendor. It talks to Vendo Cloud,
 * which owns the numbers, the identity router and the delivery. Which
 * implementation composes is decided at the seam (`selectChannels`), never by a
 * key-conditional in here — same adapter rule as ConnectionsService.
 *
 * The interface is shaped for a BYO implementation (a host's own Inkbox
 * account) even though only the Cloud one ships: `register` says where to
 * deliver and with what secret, `send` puts one message on an existing
 * conversation. Nothing else crosses. */
export interface ChannelsService {
  posture: "cloud" | false;
  /** Publish this deployment's inbound door, and learn the identity a user
   *  texts to reach it. Idempotent per deployment. */
  register(input: { url: string; secret: string }): Promise<TextChannelRegistration>;
  /** One outbound message on a conversation the user already started. There is
   *  no host-initiated send: `conversationId` always comes from an inbound
   *  event. */
  send(input: { conversationId: string; text: string }): Promise<void>;
}

/** What the router side answers: the shared triage number a person texts, the
 *  handle that identifies this deployment on it, and the exact command the
 *  first text has to carry (the code is appended to it). */
export interface TextChannelRegistration {
  identityId: string;
  handle: string;
  number: string;
  connectCommand: string;
}

/** One inbound text, as Vendo Cloud delivers it. `eventId` is the idempotency
 *  key — Cloud may retry a delivery that did not answer 202. */
export interface InboundTextEvent {
  eventId: string;
  channel: "text";
  from: string;
  text: string;
  conversationId: string;
  receivedAt: string;
}

/** Everything the link page needs: the number to text, the code to send, and
 *  the prefilled `sms:` URL a phone opens straight into. */
export interface TextChannelInvite {
  url: string;
  number: string;
  code: string;
  /** The whole first message, `connect @handle CODE`. */
  command: string;
}

/** The COMPOSED door (compose-channels.ts): the named API surface the host
 *  holds, plus the inbound runner the wire's machine door drives. */
export interface ChannelDoor {
  invite(principal: Principal): Promise<TextChannelInvite>;
  status(principal: Principal): Promise<{ linked: boolean; phone?: string }>;
  unlink(principal: Principal): Promise<void>;
  /** One delivery from Vendo Cloud: the claim of a pending link, or a turn. */
  inbound(event: InboundTextEvent): Promise<void>;
}

/** The label the inbound bearer is derived under. Frozen: both ends compute
 *  HMAC(VENDO_API_KEY, this) and must agree byte for byte. */
const INBOUND_SECRET_LABEL = "vendo:channels:text:inbound";

/** The shared secret Cloud presents on every inbound delivery, derived from the
 *  deployment's own Cloud key so nothing new has to be stored, rotated, or put
 *  in an env var. WebCrypto only (no node:crypto), so the module keeps bundling
 *  for edge/Worker targets. */
export async function channelInboundSecret(apiKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, encoder.encode(INBOUND_SECRET_LABEL)));
}

export interface CloudTextChannelOptions {
  apiKey: string;
  /** Defaults to the Vendo console; the composition seam passes VENDO_CLOUD_URL. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Per-request abort budget (default 30s, the other Cloud adapters') — a hung
   *  console must never wedge a reply. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** The shared console error table (cloud-console.ts), exactly as
 *  cloudConnections uses it. */
const raiseChannelsError = (response: Response): Promise<never> =>
  raiseCloudError(response, "channels", (code, message) => {
    throw Object.assign(new Error(message), { code: code ?? "unavailable" });
  });

/** The Cloud adapter — the OSS side of the text-channel seam. The console holds
 *  the vendor account, the numbers and the phone→deployment routing; it never
 *  learns which of the deployment's users a phone belongs to (that binding
 *  lives in the deployment's own store — see channel-links.ts). */
export function cloudTextChannel(options: CloudTextChannelOptions): ChannelsService {
  const base = (options.baseUrl ?? "https://console.vendo.run").replace(/\/$/, "");
  const send = consoleSender({
    base,
    mountPath: "",
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    fetchImpl: options.fetch ?? defaultFetch,
    raise: raiseChannelsError,
  });

  async function post(path: string, body: unknown): Promise<unknown> {
    const response = await send(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      return await response.json();
    } catch {
      // A 2xx that isn't JSON means a misdeployed Cloud base (an SPA host or a
      // proxy that 200s unknown paths). Fail loudly rather than read as a
      // successful registration with no number.
      throw new VendoError(
        "validation",
        `Vendo Cloud channels returned a non-JSON ${response.status} response — check VENDO_CLOUD_URL`,
      );
    }
  }

  return {
    posture: "cloud",
    async register(input) {
      const payload = await post("/api/v1/channels/text/register", input) as Partial<TextChannelRegistration>;
      if (typeof payload.handle !== "string" || typeof payload.number !== "string"
        || typeof payload.connectCommand !== "string" || typeof payload.identityId !== "string") {
        throw new VendoError("validation", "Vendo Cloud text registration returned no identity to text");
      }
      return {
        identityId: payload.identityId,
        handle: payload.handle,
        number: payload.number,
        connectCommand: payload.connectCommand,
      };
    },
    async send(input) {
      await post("/api/v1/channels/text/send", input);
    },
  };
}

/** The no-channel fallback: `posture: false`, and every call explains what to
 *  configure. The composition seam passes a sharper sentence when it knows what
 *  THIS config was missing (`channels: { text: true }` with no Cloud key). */
export function unconfiguredChannels(reason?: string): ChannelsService {
  const refuse = (): never => {
    throw new VendoError(
      "not-implemented",
      reason ?? "the text channel is not configured: pass createVendo({ channels: { text: true } }) and set VENDO_API_KEY",
    );
  };
  return {
    posture: false,
    register: async () => refuse(),
    send: async () => refuse(),
  };
}
