import { clerkPreset } from "@vendoai/actions/presets";
import type { AuthMaterial, PermissionGrant } from "@vendoai/core";
import { SignJWT, exportSPKI, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// clerk is pinned via its own module — the same file the
// "@vendoai/vendo/auth/clerk" subpath re-exports (corpus-triage Task 9);
// hostAuthPresetConformance still comes through the shared barrel.
import { clerk } from "./clerk.js";
import { hostAuthPresetConformance } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Hermetic Clerk instance keys: Clerk's own networkless-verification path
    (CLERK_JWT_KEY, the instance's PEM public key) verifies RS256 session
    tokens signed with our test keypair — real @clerk/backend, zero network. */
const instanceKeys = (async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
  return { privateKey, pem: await exportSPKI(publicKey) };
})();

const awaySecret = "vendo-away-token-secret-at-least-32-bytes";

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  clerk_yousef: { display: "Yousef Helal", email: "yousef@clerk.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_clerk_preset_test",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:clerk-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

async function sessionToken(
  subject: string,
  claims: Record<string, unknown> = {},
  expiresIn = "5m",
): Promise<string> {
  const { privateKey } = await instanceKeys;
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: "vendo-clerk-test-kid" })
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(privateKey);
}

function withSessionCookie(token: string): Request {
  return new Request("https://host.test/api/vendo/threads", { headers: { cookie: `__session=${token}` } });
}

/** The verify half of the producer/verify split (04 §2.1): the SAME shipped
    verifier the host mounts as middleware, driven directly. */
const awayVerifier = clerkPreset({ secret: awaySecret });
const verifyActAs = async (material: AuthMaterial): Promise<string | null> => {
  try {
    return (await awayVerifier.verify(material.headers["authorization"] ?? "")).sub;
  } catch {
    return null;
  }
};

describe("clerk() three-seam conformance (09 §2.1, away-token verify seam)", () => {
  beforeEach(async () => {
    vi.stubEnv("CLERK_JWT_KEY", (await instanceKeys).pem);
    vi.stubEnv("VENDO_AWAY_TOKEN_SECRET", awaySecret);
  });
  const suite = hostAuthPresetConformance({
    preset: clerk({ user: userResolver }),
    sessionRequest: async (subject) => withSessionCookie(await sessionToken(subject)),
    knownSubject: "clerk_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
    verifyActAs,
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("clerk() session resolution (Clerk's own conventions)", () => {
  beforeEach(async () => {
    vi.stubEnv("CLERK_JWT_KEY", (await instanceKeys).pem);
  });

  it("accepts the Authorization: Bearer session token alongside the __session cookie", async () => {
    const preset = clerk();
    const request = new Request("https://host.test/api/vendo/threads", {
      headers: { authorization: `Bearer ${await sessionToken("user_bearer")}` },
    });
    await expect(preset.principal(request)).resolves.toEqual({ kind: "user", subject: "user_bearer" });
  });

  it("derives display from name/email claims like the other presets", async () => {
    const preset = clerk();
    const resolved = await preset.principal(withSessionCookie(
      await sessionToken("user_claims", { name: "Ada Lovelace", email: "ada@clerk.test" }),
    ));
    expect(resolved).toEqual({ kind: "user", subject: "user_claims", display: "Ada Lovelace" });
  });

  it("resolves an expired session token to null (no session), not an error", async () => {
    const preset = clerk();
    await expect(preset.principal(withSessionCookie(await sessionToken("user_expired", {}, "-5m"))))
      .resolves.toBeNull();
  });

  it("throws an actionable error naming CLERK_SECRET_KEY when no verification key is configured", async () => {
    vi.unstubAllEnvs();
    const preset = clerk();
    await expect(preset.principal(withSessionCookie(await sessionToken("user_nokey"))))
      .rejects.toThrow(/CLERK_SECRET_KEY/);
  });
});

describe("clerk() actAs half (shipped away-token producer, 04 §2.1)", () => {
  beforeEach(async () => {
    vi.stubEnv("CLERK_JWT_KEY", (await instanceKeys).pem);
    vi.stubEnv("VENDO_AWAY_TOKEN_SECRET", awaySecret);
  });

  it("mints a VendoAway token the shipped host-mounted verifier accepts, carrying user claims", async () => {
    const preset = clerk({ user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "clerk_yousef" }, grantFor("clerk_yousef"));
    expect(material?.headers["authorization"]).toMatch(/^VendoAway /);
    const claims = await awayVerifier.verify(material!.headers["authorization"]!);
    expect(claims).toMatchObject({
      sub: "clerk_yousef",
      provider: "clerk",
      name: "Yousef Helal",
      email: "yousef@clerk.test",
    });
  });

  it("honors clerk({ secret }) as the away-token secret override", async () => {
    const overrideSecret = "an-explicit-away-secret-with-entropy";
    const preset = clerk({ secret: overrideSecret });
    const material = await preset.actAs?.({ kind: "user", subject: "user_override" }, grantFor("user_override"));
    const verifier = clerkPreset({ secret: overrideSecret });
    await expect(verifier.verify(material!.headers["authorization"]!)).resolves.toMatchObject({ sub: "user_override" });
    await expect(awayVerifier.verify(material!.headers["authorization"]!)).rejects.toThrow();
  });
});

describe("clerk() oauth login redirect (Clerk's sign-in convention)", () => {
  beforeEach(async () => {
    vi.stubEnv("CLERK_JWT_KEY", (await instanceKeys).pem);
  });

  it("redirects a sessionless door request to /sign-in carrying returnTo AND Clerk's redirect_url", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    const preset = clerk();
    const returnTo = "https://public.example.com/api/vendo/mcp/authorize?state=abc";
    const result = await preset.oauth?.session?.(
      new Request("http://10.0.0.7:3000/api/vendo/mcp/authorize"),
      { returnTo },
    );
    expect(result).toBeInstanceOf(Response);
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.origin).toBe("https://public.example.com");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(returnTo);
    expect(location.searchParams.get("redirect_url")).toBe(returnTo);
  });

  it("honors NEXT_PUBLIC_CLERK_SIGN_IN_URL, Clerk's own sign-in-path convention", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    vi.stubEnv("NEXT_PUBLIC_CLERK_SIGN_IN_URL", "/auth/enter");
    const preset = clerk();
    const result = await preset.oauth?.session?.(
      new Request("https://public.example.com/api/vendo/mcp/authorize"),
      { returnTo: "https://public.example.com/api/vendo/mcp/authorize?state=xyz" },
    );
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.pathname).toBe("/auth/enter");
  });
});
