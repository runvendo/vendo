/**
 * First-party service auth at the door: a host's own backend presents a service
 * key plus one of its user ids and gets back a short-lived access token bound to
 * that user (RFC 8693 token exchange, at the door's existing token endpoint).
 *
 * A key is `vsk_<keyId>_<secret>`: the keyId names it in audit (`svc:<keyId>`)
 * and picks the hash to compare against, the secret is never stored, logged, or
 * echoed. The door holds sha256 hashes only, so a leaked deployment config
 * cannot mint tokens.
 */

/** 8 hex of key id, 40 hex of secret — what `vendo` mints and the only shape a
 *  presented key can have. */
export const SERVICE_KEY_PATTERN = /^vsk_[0-9a-f]{8}_[0-9a-f]{40}$/;

/** Reserved client_id for the exchange. Not a registered client and never
 *  resolved as one: the key, not the client record, is the credential. */
export const SERVICE_CLIENT_ID = "vendo-service";

/** The subject_token a host presents is one of ITS user ids, in its own
 *  spelling — no token type in the RFC's registry describes that. */
export const SERVICE_SUBJECT_TOKEN_TYPE = "urn:vendo:params:oauth:token-type:user-id";

/** RFC 8693 §2.1. */
export const TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";

export function parseServiceKey(key: string): { keyId: string } | null {
  return SERVICE_KEY_PATTERN.test(key) ? { keyId: key.slice(4, 12) } : null;
}

/** The name a service key wears in audit and on a grant — never the key. */
export function serviceClientId(keyId: string): string {
  return `svc:${keyId}`;
}

/** The configured keys, reduced to what the door keeps: keyId → sha256(key).
 *  A malformed configured key is dropped rather than thrown on — it can never
 *  match a presented key, and a boot crash over one entry of a rotation list
 *  takes the whole deployment down. */
export async function serviceKeyHashes(keys: readonly string[]): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const key of keys) {
    const parsed = parseServiceKey(key);
    if (parsed !== null) hashes.set(parsed.keyId, await sha256Hex(key));
  }
  return hashes;
}

export async function verifyServiceKey(
  presented: string,
  hashes: ReadonlyMap<string, string>,
): Promise<{ keyId: string } | null> {
  const parsed = parseServiceKey(presented);
  if (parsed === null) return null;
  const expected = hashes.get(parsed.keyId);
  if (expected === undefined) return null;
  return equalHashes(await sha256Hex(presented), expected) ? parsed : null;
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
