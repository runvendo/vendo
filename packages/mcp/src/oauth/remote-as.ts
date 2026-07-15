import { createRemoteJWKSet, jwtVerify } from "jose";

export interface RemoteAsConfig {
  issuer: string;
  jwksUri?: string;
  audience: string;
}

export interface RemoteAccessGrant {
  kind: "access";
  subject: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
}

/** Validates bearer JWTs issued by an external authorization server. The
 * RemoteJWKSet keeps verified keys in memory and re-fetches the JWKS when an
 * unfamiliar `kid` appears, which covers ordinary zero-downtime key rotation. */
export class RemoteAsVerifier {
  readonly #config: RemoteAsConfig;
  #jwksUri: Promise<string> | undefined;
  #keys: ReturnType<typeof createRemoteJWKSet> | undefined;

  constructor(config: RemoteAsConfig) {
    this.#config = config;
  }

  async authenticate(req: Request): Promise<{ grant: RemoteAccessGrant; tokenWasPresented: true } | null> {
    const header = req.headers.get("authorization");
    const match = header?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match?.[1]) return null;
    try {
      const { payload } = await jwtVerify(match[1], await this.#keySet(), {
        algorithms: ["ES256"],
        issuer: this.#config.issuer,
        audience: this.#config.audience,
        requiredClaims: ["sub", "iat", "exp"],
      });
      const now = Math.floor(Date.now() / 1_000);
      if (
        typeof payload.sub !== "string" || payload.sub.length === 0 ||
        typeof payload.iat !== "number" || !Number.isInteger(payload.iat) || payload.iat > now ||
        typeof payload.exp !== "number" || !Number.isInteger(payload.exp) || payload.exp <= now ||
        payload.exp <= payload.iat
      ) {
        return null;
      }
      return {
        grant: {
          kind: "access",
          subject: payload.sub,
          clientId: remoteClientId(payload, this.#config.issuer),
          resource: this.#config.audience,
          scopes: remoteScopes(payload),
          expiresAt: new Date(payload.exp * 1_000).toISOString(),
        },
        tokenWasPresented: true,
      };
    } catch {
      return null;
    }
  }

  async #keySet(): Promise<ReturnType<typeof createRemoteJWKSet>> {
    if (this.#keys) return this.#keys;
    const uri = await this.#resolveJwksUri();
    // A zero cooldown lets the first JWT carrying a newly-rotated `kid` trigger
    // an immediate refresh. Known keys remain cached by jose until cacheMaxAge.
    this.#keys = createRemoteJWKSet(new URL(uri), { cooldownDuration: 0 });
    return this.#keys;
  }

  async #resolveJwksUri(): Promise<string> {
    if (this.#config.jwksUri !== undefined) return this.#config.jwksUri;
    const pending = this.#jwksUri ?? this.#discoverJwksUri();
    this.#jwksUri = pending;
    try {
      return await pending;
    } catch (error) {
      if (this.#jwksUri === pending) this.#jwksUri = undefined;
      throw error;
    }
  }

  async #discoverJwksUri(): Promise<string> {
    const issuer = this.#config.issuer.replace(/\/+$/, "");
    const response = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!response.ok) throw new Error("Authorization server metadata was unavailable");
    const metadata = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
    if (metadata.issuer !== this.#config.issuer || typeof metadata.jwks_uri !== "string") {
      throw new Error("Authorization server metadata is invalid");
    }
    return metadata.jwks_uri;
  }
}

function remoteClientId(payload: Record<string, unknown>, issuer: string): string {
  if (typeof payload.client_id === "string" && payload.client_id.length > 0) return payload.client_id;
  if (typeof payload.azp === "string" && payload.azp.length > 0) return payload.azp;
  return issuer;
}

function remoteScopes(payload: Record<string, unknown>): string[] {
  if (typeof payload.scope === "string") return uniqueScopes(payload.scope.split(/\s+/));
  if (Array.isArray(payload.scope)) return uniqueScopes(payload.scope);
  if (Array.isArray(payload.scp)) return uniqueScopes(payload.scp);
  return [];
}

function uniqueScopes(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}
