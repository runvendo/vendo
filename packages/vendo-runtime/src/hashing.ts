/**
 * Shared deterministic hashing helpers (ENG-188/ENG-193). Hashes here are
 * drift detectors, not security primitives — a fast pure-JS FNV-1a keeps the
 * runtime dependency-free and portable. Originally lived in
 * automations/grants.ts (ENG-188); hoisted so the policy layer's grant
 * matching (ENG-193 §4.3) can hash tool inputs without importing from the
 * automations module.
 */

/** JSON with recursively sorted object keys — a stable hashing input. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** FNV-1a 64-bit, hex-encoded. */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}
