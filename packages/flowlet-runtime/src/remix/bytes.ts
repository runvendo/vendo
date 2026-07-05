/**
 * Byte utilities for the remix envelope, runtime-agnostic by design: the
 * runtime ships to browsers too (portable-runtime Decision 1), so no
 * node:crypto / Buffer anywhere in shipped src.
 */

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64URL[a >> 2]! + B64URL[((a & 3) << 4) | (b >> 4)]!;
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (c >> 6)]!;
    if (i + 2 < bytes.length) out += B64URL[c & 63]!;
  }
  return out;
}

const B64URL_INDEX = new Map([...B64URL].map((ch, i) => [ch, i] as const));

/** Decode base64url; throws on any non-alphabet character or bad length. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("bad base64url length");
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let w = 0;
  for (const ch of text) {
    const value = B64URL_INDEX.get(ch);
    if (value === undefined) throw new Error("bad base64url character");
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[w++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, w);
}

/** Constant-time equality (length leak is fine; contents must not leak). */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
