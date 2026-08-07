import { encode } from "@auth/core/jwt";
import type { PermissionGrant } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
// authJs is pinned via its own module — the same file the
// "@vendoai/vendo/auth/auth-js" subpath re-exports (corpus-triage Task 9);
// hostAuthPresetConformance still comes through the shared barrel.
import { authJs } from "./auth-js.js";
import { hostAuthPresetConformance } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const secret = "vendo-authjs-preset-secret-with-entropy";

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  maple_yousef: { display: "Yousef Helal", email: "yousef@maple.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

/** Mint a REAL Auth.js v5 session JWE the way the actions preset's own tests
    verify them — @auth/core's encoder with the cookie name as salt. */
async function sessionCookie(
  subject: string,
  claims: Record<string, unknown> = {},
  cookieName = "authjs.session-token",
): Promise<string> {
  const token = await encode({ token: { sub: subject, ...claims }, secret, salt: cookieName, maxAge: 300 });
  return `${cookieName}=${token}`;
}

function withCookie(cookie: string, url = "https://host.test/api/vendo/threads"): Request {
  return new Request(url, { headers: { cookie } });
}

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_authjs_preset_test",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:authjs-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

describe("authJs() three-seam conformance (09 §2.1)", () => {
  const suite = hostAuthPresetConformance({
    preset: authJs({ secret, user: userResolver }),
    sessionRequest: async (subject) => withCookie(await sessionCookie(subject)),
    knownSubject: "maple_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("authJs() zero-argument standard case", () => {
  it("reads AUTH_SECRET from the environment and derives display from the name claim", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    const preset = authJs();
    const resolved = await preset.principal(withCookie(
      await sessionCookie("user_env", { name: "Ada Lovelace", email: "ada@host.test" }),
    ));
    expect(resolved).toEqual({ kind: "user", subject: "user_env", display: "Ada Lovelace" });
  });

  it("falls back to the email claim for display when name is absent", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    const preset = authJs();
    const resolved = await preset.principal(withCookie(
      await sessionCookie("user_env", { email: "ada@host.test" }),
    ));
    expect(resolved).toEqual({ kind: "user", subject: "user_env", display: "ada@host.test" });
  });

  it("resolves a claims-less token to a subject-only principal", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    const preset = authJs();
    const resolved = await preset.principal(withCookie(await sessionCookie("user_bare")));
    expect(resolved).toEqual({ kind: "user", subject: "user_bare" });
  });

  it("oauth.principal falls back to a subject-only principal (no claims to read)", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    const preset = authJs();
    await expect(preset.oauth?.principal("user_door")).resolves.toEqual({ kind: "user", subject: "user_door" });
  });

  it("actAs mints a session its own principal resolver accepts for ANY subject (claims-less mint)", async () => {
    // Zero-arg has no subject→user lookup, so nothing can decline — exactly
    // what lets the doctor actAs probe round-trip its synthetic subject.
    vi.stubEnv("AUTH_SECRET", secret);
    const preset = authJs();
    const material = await preset.actAs?.({ kind: "user", subject: "any_subject" }, grantFor("any_subject"));
    expect(material).not.toBeNull();
    const resolved = await preset.principal(
      new Request("https://host.test/api/vendo/doctor/act-as/echo", { headers: material!.headers }),
    );
    expect(resolved).toEqual({ kind: "user", subject: "any_subject" });
  });

  it("throws an actionable error naming AUTH_SECRET when no secret is configured", async () => {
    vi.stubEnv("AUTH_SECRET", "");
    const preset = authJs();
    await expect(preset.principal(withCookie(await sessionCookie("user_env"))))
      .rejects.toThrow(/AUTH_SECRET/);
  });
});

describe("authJs() subject→user resolver overrides", () => {
  it("user overrides claims-derived identity for the principal display", async () => {
    const preset = authJs({ secret, user: userResolver });
    const resolved = await preset.principal(withCookie(
      await sessionCookie("maple_yousef", { name: "Claims Name Ignored" }),
    ));
    expect(resolved).toEqual({ kind: "user", subject: "maple_yousef", display: "Yousef Helal" });
  });

  it("user returning null declines the session (subject unknown to host)", async () => {
    const preset = authJs({ secret, user: userResolver });
    await expect(preset.principal(withCookie(await sessionCookie("ghost")))).resolves.toBeNull();
  });

  it("user identity reaches actAs claims — the minted session carries name and email", async () => {
    const preset = authJs({ secret, user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "maple_yousef" }, grantFor("maple_yousef"));
    expect(material).not.toBeNull();
    const { getToken } = await import("@auth/core/jwt");
    await expect(getToken({ req: { headers: material!.headers }, secret })).resolves.toMatchObject({
      sub: "maple_yousef",
      name: "Yousef Helal",
      email: "yousef@maple.test",
    });
  });
});

describe("authJs() secure-cookie posture (https VENDO_BASE_URL)", () => {
  it("reads the __Secure- session cookie and ignores the plain name when the deployment is secure", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const preset = authJs({ secret });
    const secure = await sessionCookie("user_secure", {}, "__Secure-authjs.session-token");
    await expect(preset.principal(withCookie(secure)))
      .resolves.toEqual({ kind: "user", subject: "user_secure" });
    // A plain-name cookie is NOT the session under the secure posture.
    const plain = await sessionCookie("user_secure");
    await expect(preset.principal(withCookie(plain))).resolves.toBeNull();
  });

  it("actAs mints under Auth.js's __Secure- production cookie name", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const preset = authJs({ secret });
    const material = await preset.actAs?.({ kind: "user", subject: "user_secure" }, grantFor("user_secure"));
    expect(material?.headers["cookie"]).toMatch(/^__Secure-authjs\.session-token=/);
  });

  it("stays on the plain cookie name when VENDO_BASE_URL is http or unset", async () => {
    vi.stubEnv("VENDO_BASE_URL", "http://localhost:3000");
    const preset = authJs({ secret });
    const material = await preset.actAs?.({ kind: "user", subject: "user_dev" }, grantFor("user_dev"));
    expect(material?.headers["cookie"]).toMatch(/^authjs\.session-token=/);
  });

  it("resolves the actAs posture lazily at FIRST MINT, not at authJs() call time", async () => {
    // Composition can run before env loading settles (the same rationale as
    // per-call secret resolution): the preset built with no VENDO_BASE_URL in
    // sight must still mint __Secure- once the deployment turns out secure.
    const preset = authJs({ secret });
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const material = await preset.actAs?.({ kind: "user", subject: "user_late_env" }, grantFor("user_late_env"));
    expect(material?.headers["cookie"]).toMatch(/^__Secure-authjs\.session-token=/);
  });
});

describe("authJs() oauth login redirect", () => {
  it("redirects to /login on the operator-set public origin when VENDO_BASE_URL is set", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    const preset = authJs({ secret });
    const returnTo = "https://public.example.com/api/vendo/mcp/authorize?state=abc";
    const result = await preset.oauth?.session?.(
      new Request("http://10.0.0.7:3000/api/vendo/mcp/authorize"),
      { returnTo },
    );
    expect(result).toBeInstanceOf(Response);
    const location = new URL((result as Response).headers.get("location")!);
    expect(location.origin).toBe("https://public.example.com");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("returnTo")).toBe(returnTo);
  });

  it("conformance redirect case honors an operator-set VENDO_BASE_URL (env-aware expected origin)", async () => {
    // Correct preset behavior redirects to the PUBLIC origin when
    // VENDO_BASE_URL is set; the kit's expectation must move with it instead
    // of failing on the runner's environment.
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    const suite = hostAuthPresetConformance({
      preset: authJs({ secret, user: userResolver }),
      sessionRequest: async (subject) => withCookie(await sessionCookie(subject, {}, "__Secure-authjs.session-token")),
      knownSubject: "maple_yousef",
      unknownSubject: "intruder",
    });
    const redirectCase = suite.cases.find((c) => c.name.includes("redirects a sessionless request"));
    await expect(redirectCase!.run()).resolves.toBeUndefined();
  });

  it("resolves a per-call secret function lazily (demo-bank's () => authSecret() idiom)", async () => {
    const resolve = vi.fn(() => secret);
    const preset = authJs({ secret: resolve });
    expect(resolve).not.toHaveBeenCalled();
    await expect(preset.principal(withCookie(await sessionCookie("user_lazy"))))
      .resolves.toEqual({ kind: "user", subject: "user_lazy" });
    expect(resolve).toHaveBeenCalled();
  });
});
