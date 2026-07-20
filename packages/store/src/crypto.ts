import { VendoError } from "@vendoai/core";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 02-store §4 */
export function validateEncryptionKey(value: string): Buffer {
  const validCharacters = /^[A-Za-z0-9+/]+={0,2}$/.test(value);
  const decoded = Buffer.from(value, "base64");
  if (!validCharacters || decoded.byteLength !== 32) {
    throw new VendoError("validation", "encryption.key must be a base64-encoded 32-byte key");
  }
  return decoded;
}

/** 02-store §4 — envelope version `v2`: AES-256-GCM with the secret NAME
 *  bound as AAD, so a ciphertext swapped between rows (or served for the
 *  wrong name) fails the auth tag instead of decrypting to another secret's
 *  value. */
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
      version !== "v2"
      || !ivValue || !tagValue || ciphertextValue === undefined || extra !== undefined
    ) {
      throw new Error("invalid ciphertext envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64"));
    decipher.setAAD(Buffer.from(name, "utf8"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new VendoError("validation", "Stored secret could not be decrypted");
  }
}
