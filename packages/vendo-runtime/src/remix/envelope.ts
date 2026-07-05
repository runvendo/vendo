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
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { GeneratedPayload, RemixEnvelopePayload, VerifiedPinBase } from "@vendoai/core";
import { NORMALIZER_VERSION } from "./baseline.js";
import { constantTimeEqual, fromBase64Url, toBase64Url } from "./bytes.js";

export interface SealKey {
  /** Key id: fingerprint of the material + derivation path (rotation signal). */
  kid: string;
  key: Uint8Array;
}

export interface SealKeySources {
  /** Explicit seal secret (VENDO_SEAL_SECRET / handler option). Preferred. */
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
  const key = hkdf(
    sha256,
    utf8ToBytes(material),
    utf8ToBytes("vendo-remix-seal"),
    utf8ToBytes(`vendo/${path}/v1`),
    32,
  );
  const kid = bytesToHex(sha256(key)).slice(0, 12);
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

function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}

function hmacHex(key: Uint8Array, text: string): string {
  return bytesToHex(hmac(sha256, key, utf8ToBytes(text)));
}

const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

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

/** Aggregate hash of an authored sources map — the envelope's `baseHash`
 *  (per-op hashes are per-component; this one fingerprints the whole state). */
export function hashSources(sources: Record<string, string>): string {
  return sha256Hex(canonical(sources));
}

/** Encode + sign a body. Exported as the mint building block (tests use it to
 *  prove defense-in-depth checks hold even under a valid signature). */
export function sealBody(body: RemixEnvelopePayload, key: SealKey): string {
  const encoded = toBase64Url(utf8ToBytes(JSON.stringify(body)));
  const sig = hmacHex(key.key, canonical(body));
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
        payloadHash: sha256Hex(canonical(input.payload)),
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
          utf8Decode(fromBase64Url(envelope.slice(0, dot))),
        ) as RemixEnvelopePayload;
        const sig = envelope.slice(dot + 1);
        if (body.v !== 1 || body.kid !== key.kid) return null;
        const expected = hmacHex(key.key, canonical(body));
        if (!constantTimeEqual(hexToBytes(sig), hexToBytes(expected))) return null;
        if (body.anchorId !== context.anchorId) return null;
        if (body.principalUserId !== context.principalUserId) return null;
        if (body.normalizerVersion !== normalizerVersion) return null;
        if (body.payloadHash !== sha256Hex(canonical(body.payload))) return null;
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
