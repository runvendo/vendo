import { supabasePreset } from "@vendoai/actions/presets";
import type { PermissionGrant } from "@vendoai/core";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
// Imported through the same entry hosts use, pinning the re-export.
import { hostAuthPresetConformance, supabase } from "./index.js";

/** Hermetic GoTrue: jose is real (ES256 sign + verify run locally); ONLY the
    network-touching JWKS fetch is mocked at the lazy-import seam, resolving
    keys from our in-memory GoTrue JWKS instead of the wire (auth0's pattern). */
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

const gotrueKeys = (async () => {
  const { generateKeyPair, exportJWK } = await vi.importActual<typeof import("jose")>("jose");
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwksState.jwks = { keys: [{ ...jwk, alg: "ES256", kid: "vendo-supabase-test-kid", use: "sig" }] };
  return { privateKey };
})();

afterEach(() => {
  jwksState.url = undefined;
  vi.unstubAllEnvs();
});

const secret = "supabase-project-jwt-secret-at-least-32-bytes";
const projectUrl = "https://testref.supabase.co";
const jwksUrl = `${projectUrl}/auth/v1/.well-known/jwks.json`;

interface Es256Overrides {
  claims?: Record<string, unknown>;
  audience?: string | false;
  expiresIn?: string;
  key?: CryptoKey;
}

/** Mint a GoTrue-shaped ES256 login token — what `supabase start` ≥ v2.71 and
    hosted projects on the new key system sign interactive logins with. */
async function es256Token(subject: string, overrides: Es256Overrides = {}): Promise<string> {
  const { privateKey } = await gotrueKeys;
  const jwt = new SignJWT({ role: "authenticated", ...overrides.claims })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "vendo-supabase-test-kid" })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? "5m");
  if (overrides.audience !== false) jwt.setAudience(overrides.audience ?? "authenticated");
  return jwt.sign(overrides.key ?? (privateKey as CryptoKey));
}

function withBearer(token: string): Request {
  return new Request("https://host.test/api/vendo/threads", {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  supa_yousef: { display: "Yousef Helal", email: "yousef@supa.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_supabase_preset_test",
  subject,
  tool: "host_invoices_list",
  descriptorHash: "sha256:supabase-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

/** Mint a REAL Supabase HS256 access token hermetically the way the actions
    half's own tests do — the shipped supabasePreset with the project secret. */
async function accessToken(subject: string, claims: Record<string, unknown> = {}): Promise<string> {
  const mint = supabasePreset({ secret, claims: () => claims });
  const material = await mint({ kind: "user", subject }, grantFor(subject));
  return material!.headers["authorization"]!.replace(/^Bearer /, "");
}

/** The @supabase/ssr cookie shape: `sb-<ref>-auth-token` holding `base64-` +
    base64url(JSON session), optionally chunked across `.0`, `.1`, ... */
function ssrCookieValue(token: string): string {
  const session = JSON.stringify({ access_token: token, token_type: "bearer" });
  return `base64-${Buffer.from(session, "utf8").toString("base64url")}`;
}

function withCookie(cookie: string): Request {
  return new Request("https://host.test/api/vendo/threads", { headers: { cookie } });
}

async function sessionRequest(subject: string, claims: Record<string, unknown> = {}): Promise<Request> {
  return withCookie(`sb-testref-auth-token=${ssrCookieValue(await accessToken(subject, claims))}`);
}

describe("supabase() three-seam conformance (09 §2.1)", () => {
  const suite = hostAuthPresetConformance({
    preset: supabase({ secret, user: userResolver }),
    sessionRequest: (subject) => sessionRequest(subject),
    knownSubject: "supa_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("supabase() zero-argument standard case", () => {
  it("reads SUPABASE_JWT_SECRET from the environment", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", secret);
    const preset = supabase();
    await expect(preset.principal(await sessionRequest("user_env")))
      .resolves.toEqual({ kind: "user", subject: "user_env" });
  });

  it("reads SUPABASE_URL from the environment and verifies ES256 logins against GoTrue's JWKS", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    vi.stubEnv("SUPABASE_URL", projectUrl);
    const preset = supabase();
    await expect(preset.principal(withBearer(await es256Token("user_es256_env"))))
      .resolves.toEqual({ kind: "user", subject: "user_es256_env" });
    expect(jwksState.url).toBe(jwksUrl);
  });

  it("throws an actionable error naming BOTH SUPABASE_JWT_SECRET and SUPABASE_URL when neither is configured", async () => {
    vi.stubEnv("SUPABASE_JWT_SECRET", "");
    vi.stubEnv("SUPABASE_URL", "");
    const preset = supabase();
    await expect(preset.principal(await sessionRequest("user_env")))
      .rejects.toThrow(/SUPABASE_JWT_SECRET.*SUPABASE_URL|SUPABASE_URL.*SUPABASE_JWT_SECRET/s);
  });
});

describe("supabase() hybrid ES256/JWKS verification (Supabase's newer signing keys)", () => {
  it("resolves an ES256 login token to a principal with claims-derived display", async () => {
    const preset = supabase({ jwks: jwksUrl });
    await expect(preset.principal(withBearer(await es256Token("user_es256", {
      claims: { email: "ada@supa.test", user_metadata: { name: "Ada Lovelace" } },
    })))).resolves.toEqual({ kind: "user", subject: "user_es256", display: "Ada Lovelace" });
    await expect(preset.principal(withBearer(await es256Token("user_es256_mail", {
      claims: { email: "ada@supa.test" },
    })))).resolves.toEqual({ kind: "user", subject: "user_es256_mail", display: "ada@supa.test" });
  });

  it("accepts the ES256 login token off the @supabase/ssr cookie too (lazy jwks thunk)", async () => {
    // The thunk form resolves per call, so a host can derive the URL from env
    // without racing env loading at composition (the SecretSource pattern).
    const preset = supabase({ jwks: () => jwksUrl });
    const cookie = `sb-testref-auth-token=${ssrCookieValue(await es256Token("user_es256_cookie"))}`;
    await expect(preset.principal(withCookie(cookie)))
      .resolves.toEqual({ kind: "user", subject: "user_es256_cookie" });
  });

  it("verifies HS256 sessions OFFLINE first — the JWKS is never touched for them", async () => {
    vi.stubEnv("SUPABASE_URL", projectUrl);
    const preset = supabase({ secret });
    await expect(preset.principal(await sessionRequest("user_hybrid_hs")))
      .resolves.toEqual({ kind: "user", subject: "user_hybrid_hs" });
    expect(jwksState.url).toBeUndefined();
  });

  it("resolves forged (wrong-key), expired, and wrong-audience ES256 tokens to null", async () => {
    const { generateKeyPair } = await vi.importActual<typeof import("jose")>("jose");
    const { privateKey: strangerKey } = await generateKeyPair("ES256");
    const preset = supabase({ secret, jwks: jwksUrl });
    await expect(preset.principal(withBearer(await es256Token("user_forged", { key: strangerKey as CryptoKey }))))
      .resolves.toBeNull();
    await expect(preset.principal(withBearer(await es256Token("user_expired", { expiresIn: "-5m" }))))
      .resolves.toBeNull();
    await expect(preset.principal(withBearer(await es256Token("user_noaud", { audience: false }))))
      .resolves.toBeNull();
    await expect(preset.principal(withBearer(await es256Token("user_wrongaud", { audience: "anon" }))))
      .resolves.toBeNull();
  });

  it("resolves an ES256 token to null when only the HS256 secret is configured (no JWKS source)", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    const preset = supabase({ secret });
    await expect(preset.principal(withBearer(await es256Token("user_no_jwks")))).resolves.toBeNull();
  });
});

describe("supabase() hybrid three-seam conformance (ES256 sessions, HS256 actAs mints)", () => {
  // The Cadence shape: interactive logins arrive ES256-signed (verified via
  // JWKS), while the actAs half keeps minting offline HS256 tokens with the
  // project secret — one preset serves both halves.
  const suite = hostAuthPresetConformance({
    preset: supabase({ secret, jwks: jwksUrl, user: userResolver }),
    sessionRequest: async (subject) => withBearer(await es256Token(subject)),
    knownSubject: "supa_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("supabase() session resolution — Supabase's own formats", () => {
  it("accepts the Authorization: Bearer access token (how Supabase clients call the API)", async () => {
    const preset = supabase({ secret });
    const request = new Request("https://host.test/api/vendo/threads", {
      headers: { authorization: `Bearer ${await accessToken("user_bearer")}` },
    });
    await expect(preset.principal(request)).resolves.toEqual({ kind: "user", subject: "user_bearer" });
  });

  it("reads a CHUNKED @supabase/ssr cookie (sb-<ref>-auth-token.0/.1) reassembled in order", async () => {
    const preset = supabase({ secret });
    const value = ssrCookieValue(await accessToken("user_chunked"));
    const middle = Math.floor(value.length / 2);
    const cookie = `sb-testref-auth-token.0=${value.slice(0, middle)}; sb-testref-auth-token.1=${value.slice(middle)}`;
    await expect(preset.principal(withCookie(cookie))).resolves.toEqual({ kind: "user", subject: "user_chunked" });
  });

  it("reads the plain-JSON legacy cookie shape (object and [access_token, ...] array)", async () => {
    const preset = supabase({ secret });
    const token = await accessToken("user_legacy");
    const objectCookie = `sb-testref-auth-token=${encodeURIComponent(JSON.stringify({ access_token: token }))}`;
    await expect(preset.principal(withCookie(objectCookie))).resolves.toEqual({ kind: "user", subject: "user_legacy" });
    const arrayCookie = `sb-testref-auth-token=${encodeURIComponent(JSON.stringify([token, "refresh"]))}`;
    await expect(preset.principal(withCookie(arrayCookie))).resolves.toEqual({ kind: "user", subject: "user_legacy" });
  });

  it("reads a raw access token as the cookie value (hand-rolled hosts, legacy auth-helpers)", async () => {
    const preset = supabase({ secret });
    const cookie = `sb-cadence-auth-token=${await accessToken("user_raw")}`;
    await expect(preset.principal(withCookie(cookie))).resolves.toEqual({ kind: "user", subject: "user_raw" });
  });

  it("resolves a cookie-less request to null and an unverifiable token to null", async () => {
    const preset = supabase({ secret });
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads"))).resolves.toBeNull();
    const forged = supabasePreset({ secret: "a-different-project-secret-entirely" });
    const material = await forged({ kind: "user", subject: "user_forged" }, grantFor("user_forged"));
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads", { headers: material!.headers })))
      .resolves.toBeNull();
  });
});

describe("supabase() claims mapping and user resolver", () => {
  it("derives display from user_metadata.name, falling back through full_name to email", async () => {
    const preset = supabase({ secret });
    await expect(preset.principal(await sessionRequest("u1", {
      email: "ada@supa.test",
      user_metadata: { name: "Ada Lovelace" },
    }))).resolves.toEqual({ kind: "user", subject: "u1", display: "Ada Lovelace" });
    await expect(preset.principal(await sessionRequest("u2", {
      email: "ada@supa.test",
      user_metadata: { full_name: "Ada King" },
    }))).resolves.toEqual({ kind: "user", subject: "u2", display: "Ada King" });
    await expect(preset.principal(await sessionRequest("u3", { email: "ada@supa.test" })))
      .resolves.toEqual({ kind: "user", subject: "u3", display: "ada@supa.test" });
  });

  it("user overrides claims-derived identity and null declines the session", async () => {
    const preset = supabase({ secret, user: userResolver });
    await expect(preset.principal(await sessionRequest("supa_yousef", {
      user_metadata: { name: "Claims Name Ignored" },
    }))).resolves.toEqual({ kind: "user", subject: "supa_yousef", display: "Yousef Helal" });
    await expect(preset.principal(await sessionRequest("ghost"))).resolves.toBeNull();
  });

  it("user identity reaches the actAs mint — email and user_metadata.name ride the minted token", async () => {
    const preset = supabase({ secret, user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "supa_yousef" }, grantFor("supa_yousef"));
    expect(material).not.toBeNull();
    // The minted token round-trips through the preset's own resolver WITHOUT
    // the user override, proving the identity is inside the token itself.
    const claimsOnly = supabase({ secret });
    const authed = new Request("https://host.test/api/vendo/doctor/act-as/echo", { headers: material!.headers });
    await expect(claimsOnly.principal(authed))
      .resolves.toEqual({ kind: "user", subject: "supa_yousef", display: "Yousef Helal" });
  });
});
