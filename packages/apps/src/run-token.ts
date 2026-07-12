import type { AppId, RunContext } from "@vendoai/core";

/** Block-plan decision 5 — the claims carried by a short-lived machine run token. */
export interface RunTokenPayload {
  appId: AppId;
  subject: string;
  runId: string;
  presence: RunContext["presence"];
  expiresAt: number;
}

/** Block-plan decision 5 — in-memory HMAC key material. */
export type RunTokenSecret = Uint8Array | string;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const secretBytes = (secret: RunTokenSecret): Uint8Array =>
  typeof secret === "string" ? encoder.encode(secret) : secret.slice();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const fromBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const importHmacKey = async (secret: RunTokenSecret) => globalThis.crypto.subtle.importKey(
  "raw",
  secretBytes(secret),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign", "verify"],
);

const validPayload = (value: unknown): value is RunTokenPayload => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Partial<RunTokenPayload>;
  return typeof payload.appId === "string"
    && payload.appId.startsWith("app_")
    && typeof payload.subject === "string"
    && typeof payload.runId === "string"
    && payload.runId.startsWith("run_")
    && (payload.presence === "present" || payload.presence === "away")
    && typeof payload.expiresAt === "number"
    && Number.isFinite(payload.expiresAt);
};

/** Block-plan decision 5 — compact base64url JSON plus WebCrypto HMAC-SHA256. */
export const mintRunToken = async (
  secretKey: RunTokenSecret,
  payload: RunTokenPayload,
): Promise<string> => {
  const payloadPart = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secretKey),
    encoder.encode(payloadPart),
  );
  return `${payloadPart}.${toBase64Url(new Uint8Array(signature))}`;
};

/** Block-plan decision 5 — reject malformed, forged, or expired tokens without throwing. */
export const verifyRunToken = async (
  secretKey: RunTokenSecret,
  token: string,
): Promise<RunTokenPayload | null> => {
  try {
    const parts = token.split(".");
    const payloadPart = parts[0];
    const signaturePart = parts[1];
    if (parts.length !== 2 || payloadPart === undefined || signaturePart === undefined) return null;
    const payloadBytes = fromBase64Url(payloadPart);
    const signature = fromBase64Url(signaturePart);
    if (payloadBytes === null || signature === null) return null;
    const verified = await globalThis.crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secretKey),
      signature,
      encoder.encode(payloadPart),
    );
    if (!verified) return null;
    const payload = JSON.parse(decoder.decode(payloadBytes)) as unknown;
    if (!validPayload(payload) || payload.expiresAt <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};
