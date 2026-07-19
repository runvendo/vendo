import { sha256Hex, type AppId, type StoreAdapter } from "@vendoai/core";

/** execution-v2 skin contract — the per-app bearer the box calls back with.
 * Minted at provision (Lane B) and presented on every callback-surface request
 * (VENDO_STORE_URL rows + VENDO_HOST_URL tools). Follows the house de-HMAC
 * pattern (wire/context.ts anon cookie): the token itself is an opaque 256-bit
 * random value and the STORE ROW IS THE AUTHORITY — only its SHA-256 hash is
 * persisted (row id = hash), so a store dump never yields a usable bearer and
 * guessing a live token is a 2^256 search. Rotation = re-mint (the old hash
 * row is deleted); revocation = delete the app's rows. */

export const APP_TOKEN_COLLECTION = "vendo_app_tokens";

const TOKEN_PATTERN = /^vat_[0-9a-f]{64}$/;

export interface AppTokenIdentity {
  appId: AppId;
  subject: string;
}

export interface AppTokens {
  /** Mint (and rotate: any previous token for the app stops verifying). */
  mint(appId: AppId, subject: string): Promise<string>;
  /** Resolve a presented bearer to its app + owner, or null. Never throws. */
  verify(token: string): Promise<AppTokenIdentity | null>;
  /** Delete every token for the app (app deletion / de-provision). */
  revoke(appId: AppId): Promise<void>;
}

export const createAppTokens = (store: StoreAdapter): AppTokens => {
  const records = store.records(APP_TOKEN_COLLECTION);

  const revoke = async (appId: AppId): Promise<void> => {
    let cursor: string | undefined;
    do {
      const page = await records.list(cursor === undefined
        ? { refs: { app_id: appId } }
        : { refs: { app_id: appId }, cursor });
      for (const record of page.records) await records.delete(record.id);
      cursor = page.cursor;
    } while (cursor !== undefined);
  };

  return {
    async mint(appId, subject) {
      // One live token per app: minting rotates, so a leaked pre-rotation
      // bearer dies with the re-provision instead of accumulating. Rotation is
      // revoke-then-put without a store transaction; the provision path that
      // calls mint is single-flighted per app (machine lifecycle), so
      // concurrent mints for one app do not occur in practice — racing mints
      // could each leave a verifiable row until the next rotation.
      await revoke(appId);
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
      const token = `vat_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      await records.put({
        id: sha256Hex(token),
        data: { mintedAt: new Date().toISOString() },
        refs: { app_id: appId, subject },
      });
      return token;
    },
    async verify(token) {
      if (!TOKEN_PATTERN.test(token)) return null;
      // Constant-work by construction: the hash lookup is a store key equality
      // on a value the caller cannot choose collisions for (cf. run-token HMAC).
      const record = await records.get(sha256Hex(token));
      const appId = record?.refs?.["app_id"];
      const subject = record?.refs?.["subject"];
      if (typeof appId !== "string" || typeof subject !== "string") return null;
      return { appId, subject };
    },
    revoke,
  };
};
