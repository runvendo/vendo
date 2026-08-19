import { encode } from "@auth/core/jwt";
import type { PermissionGrant } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
// authJs is pinned via its own module — the same file the
// "@vendoai/vendo/auth/auth-js" subpath re-exports (corpus-triage Task 9);
// hostAuthPresetConformance still comes through the shared barrel.
import { authJs } from "../../src/auth-presets/auth-js.js";
import { hostAuthPresetConformance } from "../../src/auth-presets/index.js";

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

  it("resolves cookie-less requests to null without touching the secret or @auth/core (#872)", async () => {
    // A misconfigured preset must not take down anonymous traffic: with no
    // Auth.js session cookie there is no session to decode, so nothing that
    // can throw may run.
    vi.stubEnv("AUTH_SECRET", "");
    const preset = authJs();
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads")))
      .resolves.toBeNull();
    await expect(preset.principal(withCookie("unrelated=1; theme=dark")))
      .resolves.toBeNull();
  });

  it("reads NEXTAUTH_SECRET (next-auth v4's name) when AUTH_SECRET is absent", async () => {
    vi.stubEnv("NEXTAUTH_SECRET", secret);
    const preset = authJs();
    const resolved = await preset.principal(withCookie(await sessionCookie("user_v4_name")));
    expect(resolved).toEqual({ kind: "user", subject: "user_v4_name" });
  });

  it("prefers AUTH_SECRET over NEXTAUTH_SECRET when both are set", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    vi.stubEnv("NEXTAUTH_SECRET", "legacy-secret-that-must-lose");
    const preset = authJs();
    const resolved = await preset.principal(withCookie(await sessionCookie("user_both_names")));
    expect(resolved).toEqual({ kind: "user", subject: "user_both_names" });
  });

  it("names next-auth v4 ONCE when it sees a v4 session cookie, and resolves it as anonymous", async () => {
    vi.stubEnv("AUTH_SECRET", secret);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const preset = authJs();
      const v4Cookie = "next-auth.session-token=some-v4-jwe-vendo-cannot-read";
      await expect(preset.principal(withCookie(v4Cookie))).resolves.toBeNull();
      await expect(preset.principal(withCookie(v4Cookie))).resolves.toBeNull();
      const v4Warnings = warn.mock.calls.filter(([message]) =>
        typeof message === "string" && message.includes("next-auth v4"));
      expect(v4Warnings).toHaveLength(1);
      expect(v4Warnings[0]![0]).toContain("Auth.js v5");
    } finally {
      warn.mockRestore();
    }
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

  /** #866 — the login redirect keeps the deployment's path prefix, and
   *  VENDO_LOGIN_URL can move it off the deployment entirely. */
  it("redirects a sessionless caller to the login page UNDER the base path", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://site.com/maple");
    const preset = authJs({ secret });
    const redirect = async (): Promise<URL> => {
      const result = await preset.oauth?.session?.(
        new Request("https://site.com/maple/api/vendo/threads"),
        { returnTo: "/maple/api/vendo/threads" },
      );
      return new URL((result as Response).headers.get("location")!);
    };
    const location = await redirect();
    expect(location.pathname).toBe("/maple/login");
    expect(location.searchParams.get("returnTo")).toBe("/maple/api/vendo/threads");
    vi.stubEnv("VENDO_LOGIN_URL", "https://auth.other.com/login");
    expect((await redirect()).origin).toBe("https://auth.other.com");
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

describe("the session cookie name follows the REQUEST, not VENDO_BASE_URL", () => {
  // Auth.js decides `__Secure-` names from the request's OWN protocol. Deriving
  // them from VENDO_BASE_URL instead made the two disagree for an app served
  // over http that declares an https public URL — which the Cloud posture
  // forces — so `getToken` looked for a cookie the wire never carried and
  // returned null before it ever attempted decryption.
  const preset = authJs({ secret, user: userResolver });

  it("resolves an http request's session even when VENDO_BASE_URL is https", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const request = withCookie(await sessionCookie("maple_yousef"), "http://localhost:3004/api/vendo/threads");
    expect(await preset.principal(request)).toMatchObject({ subject: "maple_yousef" });
  });

  it("still resolves an https request's __Secure- session", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://host.test");
    const request = withCookie(
      await sessionCookie("maple_yousef", {}, "__Secure-authjs.session-token"),
      "https://host.test/api/vendo/threads",
    );
    expect(await preset.principal(request)).toMatchObject({ subject: "maple_yousef" });
  });
});

describe("the http narrowing cannot become an https downgrade", () => {
  const preset = authJs({ secret });

  it("honours a plain-named cookie on http, and never on https", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const plain = await sessionCookie("user_secure");

    // The narrowing itself: behind TLS termination the wire is http, and this
    // is the request shape real production traffic then arrives as.
    await expect(preset.principal(withCookie(plain, "http://internal:3000/api/vendo/threads")))
      .resolves.toEqual({ kind: "user", subject: "user_secure" });

    // The guarantee that has to survive it: the SAME cookie over https is
    // nobody, so anything that can write over http cannot plant a session an
    // https origin then trusts.
    await expect(preset.principal(withCookie(plain, "https://app.example.com/api/vendo/threads")))
      .resolves.toBeNull();
  });

  it("refuses a cookie renamed across the boundary, because the name is the salt", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const bodyOf = (cookie: string) => cookie.slice(cookie.indexOf("=") + 1);

    // "Plant over http, spend over https": a token minted for the plain name,
    // re-presented under the __Secure- name on an https request.
    const planted = bodyOf(await sessionCookie("user_secure"));
    await expect(preset.principal(withCookie(
      `__Secure-authjs.session-token=${planted}`,
      "https://app.example.com/api/vendo/threads",
    ))).resolves.toBeNull();

    // And the downgrade: a real __Secure- token stripped to the plain name on
    // an http request, which is the leg the narrowing newly reads.
    const stolen = bodyOf(await sessionCookie("user_secure", {}, "__Secure-authjs.session-token"));
    await expect(preset.principal(withCookie(
      `authjs.session-token=${stolen}`,
      "http://internal:3000/api/vendo/threads",
    ))).resolves.toBeNull();
  });

  it("resolves the session seam tokenFor actually calls, on an http request", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const request = withCookie(await sessionCookie("maple_yousef"), "http://internal:3000/api/vendo/threads");
    const session = await preset.oauth?.session?.(request, { returnTo: request.url });
    expect(session).toMatchObject({ subject: "maple_yousef" });
  });

  it("still mints actAs material its own principal seam accepts", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://app.example.com");
    const material = await preset.actAs?.({ kind: "user", subject: "user_secure" }, grantFor("user_secure"));
    expect(material?.headers["cookie"]).toMatch(/^__Secure-authjs\.session-token=/);
    // Mint and verify must agree: the material is replayed at the deployment's
    // own https base URL, which is where actAs sends it.
    await expect(preset.principal(new Request(
      "https://app.example.com/api/vendo/threads",
      { headers: material!.headers },
    ))).resolves.toEqual({ kind: "user", subject: "user_secure" });
  });
});
