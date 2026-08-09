/**
 * Standard-Webhooks verification, as plain functions: the base64 the secret and
 * the signature are carried in, the exact bytes a delivery signs, and the capped
 * body read that keeps an oversized delivery from being buffered whole.
 *
 * Lifted out of engine.ts unchanged.
 */
export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
};

const decodeBase64 = (value: string, url = false): Uint8Array | null => {
  try {
    let normalized = url ? value.replace(/-/g, "+").replace(/_/g, "/") : value;
    normalized += "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(normalized);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

export const verifySignature = async (
  secret: string,
  signature: string,
  signed: Uint8Array,
): Promise<boolean> => {
  const keyBytes = decodeBase64(secret, true);
  const signatureBytes = decodeBase64(signature);
  if (keyBytes === null || signatureBytes === null) return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      signed,
    );
  } catch {
    return false;
  }
};

export const signedWebhookBytes = (deliveryId: string, timestamp: string, raw: Uint8Array): Uint8Array => {
  const prefix = new TextEncoder().encode(`${deliveryId}.${timestamp}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  return signed;
};

export const readLimitedBody = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};
