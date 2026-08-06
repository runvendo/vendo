/**
 * First-party service auth at the door: a host's own backend presents a service
 * key plus one of its user ids and gets back a short-lived access token bound to
 * that user (RFC 8693 token exchange, at the door's existing token endpoint).
 *
 * A key is `vsk_<keyId>_<secret>`: the keyId names it in audit (`svc:<keyId>`),
 * the secret is compared as a digest and never stored, logged, or echoed.
 */

/** 8 hex of key id, 40 hex of secret — what `vendo` mints and the only shape a
 *  presented key can have. */
const SERVICE_KEY_PATTERN = /^vsk_[0-9a-f]{8}_[0-9a-f]{40}$/;

/** Reserved client_id for the exchange. Not a registered client and never
 *  resolved as one: the key, not the client record, is the credential. */
export const SERVICE_CLIENT_ID = "vendo-service";

/** The subject_token a host presents is one of ITS user ids, in its own
 *  spelling — no token type in the RFC's registry describes that. */
export const SERVICE_SUBJECT_TOKEN_TYPE = "urn:vendo:params:oauth:token-type:user-id";

/** RFC 8693 §2.1. */
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";

/**
 * Every configured key can actually be presented, checked where the door is
 * composed. A key no presented key can ever equal is not a stricter door: it is
 * one that ADVERTISES the exchange and answers every attempt `invalid_client`,
 * which is the most expensive possible way to learn about an unset env var or a
 * typo. The offending value never reaches the message — a malformed key is
 * usually a real key with a character wrong.
 */
export function assertServiceKeys(keys: readonly string[]): void {
  if (keys.length === 0) {
    throw new TypeError(
      "serviceAuth.keys is empty; list a key from `vendo service-key new`, or drop `serviceAuth` to close the exchange",
    );
  }
  const index = keys.findIndex((key) => !SERVICE_KEY_PATTERN.test(key));
  if (index !== -1) {
    throw new TypeError(
      `serviceAuth.keys[${index}] is not a service key: expected the \`vsk_<8 hex>_<40 hex>\` shape `
      + "`vendo service-key new` mints. The value is not echoed here.",
    );
  }
}

/** The name the presented key wears in audit and on a grant, or null if no
 *  configured key matches it. */
export async function verifyServiceKey(presented: string, keys: readonly string[]): Promise<string | null> {
  if (!SERVICE_KEY_PATTERN.test(presented)) return null;
  const hash = await sha256Hex(presented);
  for (const key of keys) {
    if (equalHashes(await sha256Hex(key), hash)) return `svc:${presented.slice(4, 12)}`;
  }
  return null;
}

/** Constant time in the CONTENT of two same-length hex digests: a compare that
 *  returns early leaks how much of a guess was right, one byte at a time. */
function equalHashes(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
