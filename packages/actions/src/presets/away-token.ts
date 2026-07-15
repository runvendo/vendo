import type { ActAs } from "@vendoai/core";
import { genericJwtPreset } from "./generic-jwt.js";
import {
  resolveClaims,
  resolveSecret,
  verifyHs256,
  type ClaimsOption,
  type SecretSource,
} from "./shared.js";

export type AwayTokenProvider = "clerk" | "auth0";

export interface AwayTokenClaims extends Record<string, unknown> {
  iss: string;
  aud: string;
  sub: string;
  provider: AwayTokenProvider;
  grantId: string;
  tool: string;
  iat: number;
  exp: number;
}

export interface AwayTokenPresetOptions {
  /** A host-owned secret shared by the producer and verifier. Defaults to VENDO_AWAY_TOKEN_SECRET. */
  secret?: SecretSource;
  issuer?: string;
  audience?: string;
  claims?: ClaimsOption;
  expiresInSeconds?: number;
  cacheSafetySeconds?: number;
}

export interface ExpressAwayTokenRequest {
  headers: Record<string, string | string[] | undefined>;
  vendoAwayToken?: AwayTokenClaims;
}

export interface ExpressAwayTokenResponse {
  status(code: number): ExpressAwayTokenResponse;
  json(body: unknown): unknown;
}

export type ExpressAwayTokenMiddleware = (
  request: ExpressAwayTokenRequest,
  response: ExpressAwayTokenResponse,
  next: () => void,
) => Promise<void>;

export interface AwayTokenPreset {
  actAs: ActAs;
  /** Verify either the compact token or its complete `VendoAway ...` header value. */
  verify(tokenOrAuthorization: string): Promise<AwayTokenClaims>;
  /** Next.js middleware.ts-compatible verifier; mount it on the host API matcher. */
  nextMiddleware(request: Request): Promise<Response>;
  /** Express middleware that attaches verified claims to req.vendoAwayToken. */
  expressMiddleware: ExpressAwayTokenMiddleware;
}

const TRUSTED_HEADERS = {
  subject: "x-vendo-away-subject",
  provider: "x-vendo-away-provider",
  grant: "x-vendo-away-grant",
  tool: "x-vendo-away-tool",
} as const;

function authorizationValue(headers: ExpressAwayTokenRequest["headers"]): string | undefined {
  const match = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "authorization")?.[1];
  return Array.isArray(match) ? match[0] : match;
}

function extractToken(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.includes(" ") && trimmed.split(".").length === 3) return trimmed;
  const match = /^VendoAway\s+(\S+)$/i.exec(trimmed);
  if (!match?.[1]) throw new Error("invalid VendoAway authorization");
  return match[1];
}

function isAwayAuthorization(value: string | undefined): value is string {
  return value !== undefined && /^VendoAway(?:\s|$)/i.test(value);
}

function invalidResponse(): Response {
  return Response.json({ error: "invalid-vendo-away-token" }, { status: 401 });
}

function makeAwayTokenPreset(
  provider: AwayTokenProvider,
  options: AwayTokenPresetOptions,
): AwayTokenPreset {
  const issuer = options.issuer ?? "vendo";
  const audience = options.audience ?? "vendo-away";
  const secretSource = options.secret ?? (() => process.env.VENDO_AWAY_TOKEN_SECRET);
  const actAs = genericJwtPreset({
    secret: secretSource,
    expiresInSeconds: options.expiresInSeconds ?? 300,
    cacheSafetySeconds: options.cacheSafetySeconds,
    jwtHeader: { typ: "vendo-away+jwt" },
    headers: (token) => ({ authorization: `VendoAway ${token}` }),
    claims: async (principal, grant) => {
      const additional = await resolveClaims(options.claims, principal, grant);
      if (additional === null) return null;
      return {
        ...additional,
        iss: issuer,
        aud: audience,
        sub: principal.subject,
        provider,
        grantId: grant.id,
        tool: grant.tool,
      };
    },
  });

  const verify = async (tokenOrAuthorization: string): Promise<AwayTokenClaims> => {
    const secret = await resolveSecret(secretSource);
    if (!secret) throw new Error("VENDO_AWAY_TOKEN_SECRET is unavailable");
    const { payload } = await verifyHs256(extractToken(tokenOrAuthorization), secret, {
      issuer,
      audience,
      type: "vendo-away+jwt",
    });
    if (
      payload.provider !== provider
      || typeof payload.sub !== "string"
      || typeof payload.grantId !== "string"
      || typeof payload.tool !== "string"
      || typeof payload.iat !== "number"
      || typeof payload.exp !== "number"
    ) {
      throw new Error("invalid Vendo away-token claims");
    }
    return payload as AwayTokenClaims;
  };

  const expressMiddleware: ExpressAwayTokenMiddleware = async (request, response, next) => {
    delete request.vendoAwayToken;
    const authorization = authorizationValue(request.headers);
    if (!isAwayAuthorization(authorization)) {
      next();
      return;
    }
    try {
      request.vendoAwayToken = await verify(authorization);
      next();
    } catch {
      response.status(401).json({ error: "invalid-vendo-away-token" });
    }
  };

  const nextMiddleware = async (request: Request): Promise<Response> => {
    const { NextResponse } = await import("next/server.js");
    const headers = new Headers(request.headers);
    for (const name of Object.values(TRUSTED_HEADERS)) headers.delete(name);
    const authorization = headers.get("authorization") ?? undefined;
    if (!isAwayAuthorization(authorization)) return NextResponse.next({ request: { headers } });
    let claims: AwayTokenClaims;
    try {
      claims = await verify(authorization);
    } catch {
      return invalidResponse();
    }
    headers.set(TRUSTED_HEADERS.subject, claims.sub);
    headers.set(TRUSTED_HEADERS.provider, claims.provider);
    headers.set(TRUSTED_HEADERS.grant, claims.grantId);
    headers.set(TRUSTED_HEADERS.tool, claims.tool);
    return NextResponse.next({ request: { headers } });
  };

  return { actAs, verify, expressMiddleware, nextMiddleware };
}

/** Clerk cannot mint provider RS256 sessions offline, so this uses a host-owned away-token. */
export function clerkPreset(options: AwayTokenPresetOptions = {}): AwayTokenPreset {
  return makeAwayTokenPreset("clerk", options);
}

/** Auth0 cannot mint provider RS256 sessions offline, so this uses a host-owned away-token. */
export function auth0Preset(options: AwayTokenPresetOptions = {}): AwayTokenPreset {
  return makeAwayTokenPreset("auth0", options);
}
