/**
 * Sealed authored-state envelope (remix fast-edits spec, 2026-07-04). Pins are
 * client-persisted, so the authored (pre-compile) state a pin edit patches
 * must cross the client — this seal is what lets it come back without being
 * trusted: HMAC over canonical JSON, bound to anchor + principal + normalizer
 * version. Verification failure DEGRADES (no pin base this turn), never
 * escalates.
 *
 * Format: `base64url(bodyJson).hex(hmacSha256(canonical(body)))`. The body is
 * re-canonicalized before signature check, so key order never matters.
 */
import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import type { GeneratedPayload, RemixEnvelopePayload, VerifiedPinBase } from "@flowlet/core";
import { NORMALIZER_VERSION } from "./baseline";

export interface SealKey {
  /** Key id: fingerprint of the material + derivation path (rotation signal). */
  kid: string;
  key: Buffer;
}

export interface SealKeySources {
  /** Explicit seal secret (FLOWLET_SEAL_SECRET / handler option). Preferred. */
  secret?: string | undefined;
  /** Provider API key material for the zero-config HKDF fallback. */
  providerKey?: string | undefined;
}

/** Derive the seal key. Explicit secret wins; else HKDF from the provider
 *  key (rotation gracefully invalidates envelopes); else null → sealing off. */
export function deriveSealKey(sources: SealKeySources): SealKey | null {
  const material = sources.secret ?? sources.providerKey;
  if (!material) return null;
  const path = sources.secret ? "secret" : "provider-hkdf";
  const key = Buffer.from(
    hkdfSync("sha256", material, "flowlet-remix-seal", `flowlet/${path}/v1`, 32),
  );
  const kid = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return { kid, key };
}

export interface MintInput {
  anchorId: string;
  principalUserId: string;
  payload: GeneratedPayload;
  sources: Record<string, string>;
  sourceHash: string;
  baseHash: string;
  issuedAt: string;
}

export interface VerifyContext {
  anchorId: string;
  principalUserId: string;
}

export interface RemixSealer {
  mint(input: MintInput): string;
  /** Returns the verified pin base, or null on ANY failure (never throws). */
  verify(envelope: string, context: VerifyContext): VerifiedPinBase | null;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted recursively (arrays keep order). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Encode + sign a body. Exported as the mint building block (tests use it to
 *  prove defense-in-depth checks hold even under a valid signature). */
export function sealBody(body: RemixEnvelopePayload, key: SealKey): string {
  const encoded = Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
  const sig = createHmac("sha256", key.key).update(canonical(body)).digest("hex");
  return `${encoded}.${sig}`;
}

export function createRemixSealer(
  key: SealKey,
  options: { normalizerVersion?: string } = {},
): RemixSealer {
  const normalizerVersion = options.normalizerVersion ?? NORMALIZER_VERSION;
  return {
    mint(input) {
      const body: RemixEnvelopePayload = {
        v: 1,
        kid: key.kid,
        anchorId: input.anchorId,
        principalUserId: input.principalUserId,
        payload: input.payload,
        sources: input.sources,
        sourceHash: input.sourceHash,
        baseHash: input.baseHash,
        payloadHash: sha256(canonical(input.payload)),
        normalizerVersion,
        issuedAt: input.issuedAt,
      };
      return sealBody(body, key);
    },

    verify(envelope, context) {
      try {
        const dot = envelope.lastIndexOf(".");
        if (dot <= 0) return null;
        const body = JSON.parse(
          Buffer.from(envelope.slice(0, dot), "base64url").toString("utf8"),
        ) as RemixEnvelopePayload;
        const sig = envelope.slice(dot + 1);
        if (body.v !== 1 || body.kid !== key.kid) return null;
        const expected = createHmac("sha256", key.key).update(canonical(body)).digest("hex");
        const sigBuf = Buffer.from(sig, "hex");
        const expBuf = Buffer.from(expected, "hex");
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;
        if (body.anchorId !== context.anchorId) return null;
        if (body.principalUserId !== context.principalUserId) return null;
        if (body.normalizerVersion !== normalizerVersion) return null;
        if (body.payloadHash !== sha256(canonical(body.payload))) return null;
        if (typeof body.baseHash !== "string" || typeof body.sourceHash !== "string") return null;
        return {
          payload: body.payload,
          sources: body.sources,
          baseHash: body.baseHash,
          sourceHash: body.sourceHash,
        };
      } catch {
        return null; // malformed input is a degrade, never an error path
      }
    },
  };
}
