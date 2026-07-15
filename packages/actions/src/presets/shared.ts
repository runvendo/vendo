import type { PermissionGrant, Principal } from "@vendoai/core";

export type Awaitable<T> = T | Promise<T>;
export type SecretSource = string | (() => Awaitable<string | undefined>);
export type JwtClaims = Record<string, unknown>;
export type ClaimsResolver = (
  principal: Principal,
  grant: PermissionGrant,
) => Awaitable<JwtClaims | null>;
export type ClaimsOption = JwtClaims | ClaimsResolver;

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class TokenCache {
  readonly #tokens = new Map<string, CachedToken>();

  get size(): number {
    return this.#tokens.size;
  }

  get(key: string, nowMs: number, safetyMs: number): string | undefined {
    const cached = this.#tokens.get(key);
    if (!cached) return undefined;
    if (nowMs >= cached.expiresAtMs - safetyMs) {
      this.#tokens.delete(key);
      return undefined;
    }
    return cached.token;
  }

  set(key: string, token: string, expiresAtMs: number, nowMs: number): void {
    // Evict every expired entry so keys that are never read again (users who
    // stop triggering runs, rotated secrets) cannot grow the cache unbounded.
    for (const [cachedKey, cached] of this.#tokens) {
      if (nowMs >= cached.expiresAtMs) this.#tokens.delete(cachedKey);
    }
    this.#tokens.set(key, { token, expiresAtMs });
  }
}

export function assertLifetime(expiresInSeconds: number, cacheSafetySeconds: number): void {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    throw new TypeError("expiresInSeconds must be greater than zero");
  }
  if (!Number.isFinite(cacheSafetySeconds) || cacheSafetySeconds < 0) {
    throw new TypeError("cacheSafetySeconds must be zero or greater");
  }
}

export async function resolveSecret(
  source: SecretSource | undefined,
  fallbackEnvironmentName?: string,
): Promise<string | undefined> {
  const value = source === undefined
    ? (fallbackEnvironmentName ? process.env[fallbackEnvironmentName] : undefined)
    : typeof source === "function"
      ? await source()
      : source;
  return value && value.length > 0 ? value : undefined;
}

export async function resolveClaims(
  option: ClaimsOption | undefined,
  principal: Principal,
  grant: PermissionGrant,
): Promise<JwtClaims | null> {
  if (option === undefined) return {};
  const claims = typeof option === "function" ? await option(principal, grant) : option;
  return claims === null ? null : { ...claims };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new Error("invalid base64url encoding");
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function secretFingerprint(secret: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return toBase64Url(new Uint8Array(digest));
}

function encodeJson(value: unknown): string {
  return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(value))) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signHs256(
  payload: JwtClaims,
  secret: string,
  header: JwtClaims = {},
): Promise<string> {
  const protectedHeader = encodeJson({ typ: "JWT", ...header, alg: "HS256" });
  const encodedPayload = encodeJson(payload);
  const signingInput = `${protectedHeader}.${encodedPayload}`;
  const key = await hmacKey(secret, "sign");
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export interface VerifyHs256Options {
  nowSeconds?: number;
  issuer?: string;
  audience?: string;
  type?: string;
}

export async function verifyHs256(
  token: string,
  secret: string,
  options: VerifyHs256Options = {},
): Promise<{ header: JwtClaims; payload: JwtClaims }> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid JWT shape");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let received: Uint8Array;
  try {
    received = fromBase64Url(encodedSignature);
  } catch {
    throw new Error("invalid JWT signature encoding");
  }
  const key = await hmacKey(secret, "verify");
  const validSignature = await globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(received),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!validSignature) {
    throw new Error("invalid JWT signature");
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = decodeJson(encodedHeader);
    payload = decodeJson(encodedPayload);
  } catch {
    throw new Error("invalid JWT JSON");
  }
  if (!isRecord(header) || header.alg !== "HS256") throw new Error("invalid JWT algorithm");
  if (!isRecord(payload)) throw new Error("invalid JWT payload");
  if (options.type !== undefined && header.typ !== options.type) throw new Error("invalid JWT type");
  if (options.issuer !== undefined && payload.iss !== options.issuer) throw new Error("invalid JWT issuer");
  if (options.audience !== undefined) {
    const audience = payload.aud;
    if (audience !== options.audience && !(Array.isArray(audience) && audience.includes(options.audience))) {
      throw new Error("invalid JWT audience");
    }
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= now) {
    throw new Error("expired JWT");
  }
  if (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now)) {
    throw new Error("JWT is not active");
  }
  return { header, payload };
}
