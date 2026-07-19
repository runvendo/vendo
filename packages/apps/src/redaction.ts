import type { Json, SecretsProvider } from "@vendoai/core";

/**
 * execution-v2 Wave 2 Lane E — the defensive redaction guard at the box
 * boundary (spec "Secrets and egress"). A granted secret's real value lives
 * INSIDE the box; nothing host-side may re-absorb it. This module scrubs
 * known secret values from everything crossing back over the skin — fn proxy
 * responses, /box callback outcomes, row payloads, error messages — replacing
 * each occurrence with `[redacted:<name>]`. It is defense in depth, not the
 * primary control (the primary controls are the grant gate on injection and
 * the egress allowlist): a box that echoes its own env into an fn response
 * must not turn the host's store, logs, or clients into a secret sink.
 */

/** Values shorter than this are not scrubbed: replacing very short strings
    (e.g. a secret set to "1") would mangle unrelated payloads wholesale. */
const MIN_REDACTABLE_LENGTH = 4;

/**
 * Resolve the redactable values for an app's declared secrets — ALL declared
 * names, granted or not (defense in depth: an ungranted value should never
 * appear anywhere, so scrub it too if it somehow does). A failing provider
 * never breaks the response path.
 */
export const collectSecretValues = async (
  names: readonly string[] | undefined,
  secrets: SecretsProvider | undefined,
): Promise<Map<string, string>> => {
  const values = new Map<string, string>();
  if (secrets === undefined) return values;
  for (const name of new Set(names ?? [])) {
    try {
      const value = await secrets.get(name);
      if (typeof value === "string" && value.length >= MIN_REDACTABLE_LENGTH) {
        values.set(name, value);
      }
    } catch {
      // Redaction is best-effort armor; a provider hiccup must not 500 the box door.
    }
  }
  return values;
};

/** Replace every occurrence of every known secret value in one string. */
export const redactSecretText = (text: string, values: ReadonlyMap<string, string>): string => {
  let out = text;
  for (const [name, value] of values) {
    if (out.includes(value)) out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
};

/** Deep-scrub a JSON-ish value: every string leaf (and object key) is redacted. */
export const redactSecretJson = (input: Json, values: ReadonlyMap<string, string>): Json => {
  if (values.size === 0) return input;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return redactSecretText(value, values);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [redactSecretText(key, values), walk(entry)]),
      );
    }
    return value;
  };
  return walk(input);
};
