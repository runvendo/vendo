import { VendoError } from "@vendoai/core";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, validateEncryptionKey } from "../crypto.js";

// Adversarial regression suite for the AES-256-GCM secret envelope (02-store §4).
// Secrets are the highest-value rows in the store; this pins the guarantees that
// make the ciphertext safe at rest: authenticated encryption, per-message random
// IVs, integrity on both ciphertext and tag, and a generic (oracle-free) error.

const key = (): Buffer => randomBytes(32);

const envelopeParts = (value: string): { version: string; iv: string; tag: string; ct: string } => {
  const [version, iv, tag, ct] = value.split(":");
  return { version: version ?? "", iv: iv ?? "", tag: tag ?? "", ct: ct ?? "" };
};

// Flip the first byte of a base64 segment, returning a same-length base64 segment.
const tamperBase64 = (segment: string): string => {
  const bytes = Buffer.from(segment, "base64");
  bytes[0] = bytes[0] ^ 0xff;
  return bytes.toString("base64");
};

describe("encryptSecret / decryptSecret round-trip", () => {
  it("returns the exact plaintext through an encrypt -> decrypt cycle", () => {
    const k = key();
    const plaintext = "sk-live-super-secret-🔐-value";
    expect(decryptSecret(encryptSecret(plaintext, k), k)).toBe(plaintext);
  });

  it("produces a v1:iv:tag:ct envelope with a fresh 12-byte IV every time (no IV reuse)", () => {
    const k = key();
    const a = encryptSecret("same-plaintext", k);
    const b = encryptSecret("same-plaintext", k);
    // Two encryptions of identical plaintext must differ — random IV per message.
    expect(a).not.toBe(b);

    const partsA = envelopeParts(a);
    const partsB = envelopeParts(b);
    expect(partsA.version).toBe("v1");
    expect(Buffer.from(partsA.iv, "base64").byteLength).toBe(12);
    expect(partsA.iv).not.toBe(partsB.iv); // distinct IVs
    expect(partsA.ct).not.toBe(partsB.ct); // distinct ciphertexts
  });
});

describe("GCM integrity", () => {
  it("throws when any byte of the ciphertext is tampered", () => {
    const k = key();
    const parts = envelopeParts(encryptSecret("integrity-me", k));
    const forged = `v1:${parts.iv}:${parts.tag}:${tamperBase64(parts.ct)}`;
    expect(() => decryptSecret(forged, k)).toThrow(VendoError);
  });

  it("throws when the auth tag is tampered", () => {
    const k = key();
    const parts = envelopeParts(encryptSecret("integrity-me", k));
    const forged = `v1:${parts.iv}:${tamperBase64(parts.tag)}:${parts.ct}`;
    expect(() => decryptSecret(forged, k)).toThrow(VendoError);
  });

  it("throws when the IV is tampered", () => {
    const k = key();
    const parts = envelopeParts(encryptSecret("integrity-me", k));
    const forged = `v1:${tamperBase64(parts.iv)}:${parts.tag}:${parts.ct}`;
    expect(() => decryptSecret(forged, k)).toThrow(VendoError);
  });
});

describe("wrong key and malformed envelope", () => {
  it("throws when decrypting with a different key", () => {
    const sealed = encryptSecret("cross-tenant", key());
    expect(() => decryptSecret(sealed, key())).toThrow(VendoError);
  });

  it("throws for a wrong version, missing segment, or extra trailing segment", () => {
    const k = key();
    const parts = envelopeParts(encryptSecret("shape", k));
    const malformed = [
      `v2:${parts.iv}:${parts.tag}:${parts.ct}`, // wrong version
      `v1:${parts.iv}:${parts.tag}`, // missing ciphertext segment
      `v1:${parts.tag}:${parts.ct}`, // missing a segment (shifts positions)
      `v1:${parts.iv}:${parts.tag}:${parts.ct}:extra`, // extra trailing segment
      "", // empty
      "not-an-envelope",
    ];
    for (const value of malformed) {
      expect(() => decryptSecret(value, k)).toThrow(VendoError);
    }
  });

  it("never leaks plaintext or an oracle in the decrypt error message", () => {
    const k = key();
    const parts = envelopeParts(encryptSecret("top-secret-oracle-bait", k));
    try {
      decryptSecret(`v1:${parts.iv}:${tamperBase64(parts.tag)}:${parts.ct}`, k);
      throw new Error("expected decryptSecret to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(VendoError);
      const message = (error as VendoError).message;
      expect(message).toBe("Stored secret could not be decrypted");
      expect(message).not.toContain("top-secret");
    }
  });
});

describe("validateEncryptionKey", () => {
  it("accepts a base64-encoded 32-byte key", () => {
    const value = randomBytes(32).toString("base64");
    expect(validateEncryptionKey(value).byteLength).toBe(32);
  });

  it("rejects keys that decode to the wrong length", () => {
    for (const size of [16, 24, 31, 33, 64]) {
      expect(() => validateEncryptionKey(randomBytes(size).toString("base64")))
        .toThrow(expect.objectContaining<VendoError>({ code: "validation" }));
    }
  });

  it("rejects non-base64 / non-canonical strings", () => {
    for (const value of ["not valid base64 !!!", "@@@@", "====", "  "]) {
      expect(() => validateEncryptionKey(value)).toThrow(VendoError);
    }
  });
});
