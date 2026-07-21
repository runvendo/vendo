import { auth0Preset } from "@vendoai/actions/presets";
import type { AuthMaterial, PermissionGrant } from "@vendoai/core";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// auth0 is pinned via its own module — the same file the
// "@vendoai/vendo/auth/auth0" subpath re-exports (corpus-triage Task 9);
// hostAuthPresetConformance still comes through the shared barrel.
import { auth0 } from "./auth0.js";
import { hostAuthPresetConformance } from "./index.js";

/** Hermetic tenant: jose is real (RS256 sign + verify run locally); ONLY the
    network-touching JWKS fetch is mocked at the lazy-import seam, resolving
    keys from our in-memory tenant JWKS instead of the wire. */
const jwksState = vi.hoisted(() => ({
  jwks: undefined as unknown,
  url: undefined as string | undefined,
}));
vi.mock("jose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jose")>();
  return {
    ...actual,
    createRemoteJWKSet: (url: URL) => {
      jwksState.url = url.toString();
      return actual.createLocalJWKSet(jwksState.jwks as never);
    },
  };
});

const tenantDomain = "vendo-test.us.auth0.com";
const tenantIssuer = `https://${tenantDomain}/`;
const awaySecret = "vendo-away-token-secret-at-least-32-bytes";

const tenantKeys = (async () => {
  const { generateKeyPair, exportJWK } = await vi.importActual<typeof import("jose")>("jose");
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  const jwk = await exportJWK(publicKey);
  jwksState.jwks = { keys: [{ ...jwk, alg: "RS256", kid: "vendo-auth0-test-kid", use: "sig" }] };
  return { privateKey };
})();

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  auth0_yousef: { display: "Yousef Helal", email: "yousef@auth0.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_auth0_preset_test",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:auth0-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

interface TokenOverrides {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
}

async function sessionToken(subject: string, overrides: TokenOverrides = {}): Promise<string> {
  const { privateKey } = await tenantKeys;
  const jwt = new SignJWT({ ...overrides.claims })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "vendo-auth0-test-kid" })
    .setSubject(subject)
    .setIssuer(overrides.issuer ?? tenantIssuer)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m");
  if (overrides.audience !== undefined) jwt.setAudience(overrides.audience);
  return jwt.sign(privateKey);
}

function withBearer(token: string): Request {
  return new Request("https://host.test/api/vendo/threads", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** The verify half of the producer/verify split (04 §2.1): the SAME shipped
    verifier the host mounts as middleware, driven directly. */
const awayVerifier = auth0Preset({ secret: awaySecret });
const verifyActAs = async (material: AuthMaterial): Promise<string | null> => {
  try {
    return (await awayVerifier.verify(material.headers["authorization"] ?? "")).sub;
  } catch {
    return null;
  }
};

describe("auth0() three-seam conformance (09 §2.1, away-token verify seam)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
    vi.stubEnv("VENDO_AWAY_TOKEN_SECRET", awaySecret);
  });
  const suite = hostAuthPresetConformance({
    preset: auth0({ user: userResolver }),
    sessionRequest: async (subject) => withBearer(await sessionToken(subject)),
    knownSubject: "auth0_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
    verifyActAs,
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("auth0() tenant environment (Auth0's own conventions)", () => {
  it("reads AUTH0_DOMAIN and verifies against the tenant's JWKS endpoint", async () => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
    const preset = auth0();
    await expect(preset.principal(withBearer(await sessionToken("user_env"))))
      .resolves.toEqual({ kind: "user", subject: "user_env" });
    expect(jwksState.url).toBe(`https://${tenantDomain}/.well-known/jwks.json`);
  });

  it("falls back to AUTH0_ISSUER_BASE_URL (the v3 SDK convention)", async () => {
    vi.stubEnv("AUTH0_ISSUER_BASE_URL", `https://${tenantDomain}`);
    const preset = auth0();
    await expect(preset.principal(withBearer(await sessionToken("user_issuer_base"))))
      .resolves.toEqual({ kind: "user", subject: "user_issuer_base" });
  });

  it("throws an actionable error naming AUTH0_DOMAIN when no tenant is configured", async () => {
    const preset = auth0();
    await expect(preset.principal(withBearer(await sessionToken("user_nodomain"))))
      .rejects.toThrow(/AUTH0_DOMAIN/);
  });

  it("enforces AUTH0_AUDIENCE when set", async () => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
    vi.stubEnv("AUTH0_AUDIENCE", "https://api.host.test");
    const preset = auth0();
    await expect(preset.principal(withBearer(await sessionToken("user_noaud")))).resolves.toBeNull();
    await expect(preset.principal(withBearer(await sessionToken("user_aud", { audience: "https://api.host.test" }))))
      .resolves.toEqual({ kind: "user", subject: "user_aud" });
  });
});

describe("auth0() session resolution and claims mapping", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
  });

  it("derives display from the OIDC name claim, falling back to email", async () => {
    const preset = auth0();
    const resolved = await preset.principal(withBearer(
      await sessionToken("user_claims", { claims: { name: "Ada Lovelace", email: "ada@auth0.test" } }),
    ));
    expect(resolved).toEqual({ kind: "user", subject: "user_claims", display: "Ada Lovelace" });
  });

  it("resolves foreign-issuer and expired tokens to null (no session), not an error", async () => {
    const preset = auth0();
    await expect(preset.principal(withBearer(
      await sessionToken("user_foreign", { issuer: "https://someone-else.us.auth0.com/" }),
    ))).resolves.toBeNull();
    await expect(preset.principal(withBearer(
      await sessionToken("user_expired", { expiresIn: "-5m" }),
    ))).resolves.toBeNull();
  });
});

describe("auth0() actAs half (shipped away-token producer, 04 §2.1)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
    vi.stubEnv("VENDO_AWAY_TOKEN_SECRET", awaySecret);
  });

  it("mints a VendoAway token the shipped host-mounted verifier accepts, carrying user claims", async () => {
    const preset = auth0({ user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "auth0_yousef" }, grantFor("auth0_yousef"));
    expect(material?.headers["authorization"]).toMatch(/^VendoAway /);
    const claims = await awayVerifier.verify(material!.headers["authorization"]!);
    expect(claims).toMatchObject({
      sub: "auth0_yousef",
      provider: "auth0",
      name: "Yousef Helal",
      email: "yousef@auth0.test",
    });
  });

  it("honors auth0({ secret }) as the away-token secret override", async () => {
    const overrideSecret = "an-explicit-away-secret-with-entropy";
    const preset = auth0({ secret: overrideSecret });
    const material = await preset.actAs?.({ kind: "user", subject: "user_override" }, grantFor("user_override"));
    const verifier = auth0Preset({ secret: overrideSecret });
    await expect(verifier.verify(material!.headers["authorization"]!)).resolves.toMatchObject({ sub: "user_override" });
    await expect(awayVerifier.verify(material!.headers["authorization"]!)).rejects.toThrow();
  });
});

describe("auth0() oauth login redirect (Auth0 v4 SDK route convention)", () => {
  it("redirects a sessionless door request to /auth/login carrying returnTo", async () => {
    vi.stubEnv("AUTH0_DOMAIN", tenantDomain);
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    const preset = auth0();
    const returnTo = "https://public.example.com/api/vendo/mcp/authorize?state=abc";
    const result = await preset.oauth?.session?.(
      new Request("http://10.0.0.7:3000/api/vendo/mcp/authorize"),
      { returnTo },
    );
    expect(result).toBeInstanceOf(Response);
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.origin).toBe("https://public.example.com");
    // The Auth0 v4 SDK mounts its login at /auth/login and natively honors returnTo.
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("returnTo")).toBe(returnTo);
  });
});
