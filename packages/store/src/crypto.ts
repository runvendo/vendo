import { VendoError } from "@vendoai/core";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const keys = new WeakMap<object, Buffer>();

/** 02-store §4 */
export function validateEncryptionKey(value: string): Buffer {
  const normalized = value.replace(/=+$/, "");
  const validCharacters = /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "") === normalized;
  if (!validCharacters || !canonical || decoded.byteLength !== 32) {
    throw new VendoError("validation", "encryption.key must be a base64-encoded 32-byte key");
  }
  return decoded;
}

export function setEncryptionKey(store: object, key: Buffer | undefined): void {
  if (key) keys.set(store, key);
}

export function getEncryptionKey(store: object): Buffer | undefined {
  return keys.get(store);
}

export function dropEncryptionKey(store: object): void {
  keys.delete(store);
}

/** 02-store §4 — envelope versions:
 *  - `v1`: legacy AES-256-GCM, no AAD. Still decrypted so rows written before
 *    the AAD amendment keep working; never written anymore.
 *  - `v2`: AES-256-GCM with the secret NAME bound as AAD, so a ciphertext
 *    swapped between rows (or served for the wrong name) fails the auth tag
 *    instead of decrypting to another secret's value. */
export function encryptSecret(value: string, key: Buffer, name: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

/** 02-store §4 */
export function decryptSecret(value: string, key: Buffer, name: string): string {
  try {
    const [version, ivValue, tagValue, ciphertextValue, extra] = value.split(":");
    if (
      (version !== "v1" && version !== "v2")
      || !ivValue || !tagValue || ciphertextValue === undefined || extra !== undefined
    ) {
      throw new Error("invalid ciphertext envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64"));
    if (version === "v2") decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VendoError("validation", "Stored secret could not be decrypted");
  }
}
