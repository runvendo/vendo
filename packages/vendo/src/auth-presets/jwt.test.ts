import { genericJwtPreset, verifyHs256 } from "@vendoai/actions/presets";
import type { PermissionGrant } from "@vendoai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
// jwt is pinned via its own module — the same file the
// "@vendoai/vendo/auth/jwt" subpath re-exports (corpus-triage Task 9);
// hostAuthPresetConformance still comes through the shared barrel.
import { jwt } from "./jwt.js";
import { hostAuthPresetConformance } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const secret = "vendo-host-generic-jwt-secret-with-entropy";

/** The host-side user table a subject→user resolver fronts (demo-bank idiom). */
const users: Record<string, { display: string; email: string }> = {
  host_yousef: { display: "Yousef Helal", email: "yousef@host.test" },
};
const userResolver = (subject: string): { display: string; email: string } | null =>
  users[subject] ?? null;

const grantFor = (subject: string): PermissionGrant => ({
  id: "grt_jwt_preset_test",
  subject,
  tool: "host_profile",
  descriptorHash: "sha256:jwt-preset-test",
  scope: { kind: "tool" },
  duration: "standing",
  source: "automation",
  grantedAt: "2026-07-18T00:00:00.000Z",
});

/** Mint a REAL host JWT hermetically the way the actions half does — the
    shipped genericJwtPreset with the same secret. */
async function bearerRequest(
  subject: string,
  claims: Record<string, unknown> = {},
  mintSecret = secret,
): Promise<Request> {
  const mint = genericJwtPreset({ secret: mintSecret, claims: () => claims });
  const material = await mint({ kind: "user", subject }, grantFor(subject));
  return new Request("https://host.test/api/vendo/threads", { headers: material!.headers });
}

describe("jwt() three-seam conformance (09 §2.1)", () => {
  const suite = hostAuthPresetConformance({
    preset: jwt({ secret, user: userResolver }),
    sessionRequest: (subject) => bearerRequest(subject),
    knownSubject: "host_yousef",
    unknownSubject: "intruder",
    expectedDisplay: "Yousef Helal",
  });
  for (const conformanceCase of suite.cases) {
    it(conformanceCase.name, conformanceCase.run);
  }
});

describe("jwt() option surface", () => {
  it("is NOT zero-argument: constructing without a secret throws the actionable explanation", () => {
    // A host-generic JWT scheme has no vendor-owned env variable to read.
    expect(() => jwt()).toThrow(/jwt\(\{ secret \}\)/);
  });

  it("throws an actionable error when a lazy secret source resolves empty", async () => {
    const preset = jwt({ secret: () => undefined });
    await expect(preset.principal(await bearerRequest("user_lazy")))
      .rejects.toThrow(/secret/);
  });

  it("resolves a per-call secret function lazily (never at construction)", async () => {
    const resolve = vi.fn(() => secret);
    const preset = jwt({ secret: resolve });
    expect(resolve).not.toHaveBeenCalled();
    await expect(preset.principal(await bearerRequest("user_lazy")))
      .resolves.toEqual({ kind: "user", subject: "user_lazy" });
    expect(resolve).toHaveBeenCalled();
  });
});

describe("jwt() session resolution and claims mapping", () => {
  it("derives display from the name claim, falling back to email", async () => {
    const preset = jwt({ secret });
    await expect(preset.principal(await bearerRequest("user_a", { name: "Ada Lovelace", email: "ada@host.test" })))
      .resolves.toEqual({ kind: "user", subject: "user_a", display: "Ada Lovelace" });
    await expect(preset.principal(await bearerRequest("user_b", { email: "ada@host.test" })))
      .resolves.toEqual({ kind: "user", subject: "user_b", display: "ada@host.test" });
  });

  it("resolves a request signed with a DIFFERENT secret to null (no session)", async () => {
    const preset = jwt({ secret });
    await expect(preset.principal(await bearerRequest("user_forged", {}, "some-other-secret-with-entropy")))
      .resolves.toBeNull();
  });

  it("resolves a bearer-less request to null without touching the secret", async () => {
    const resolve = vi.fn(() => secret);
    const preset = jwt({ secret: resolve });
    await expect(preset.principal(new Request("https://host.test/api/vendo/threads"))).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("user returning null declines the session (subject unknown to host)", async () => {
    const preset = jwt({ secret, user: userResolver });
    await expect(preset.principal(await bearerRequest("ghost"))).resolves.toBeNull();
  });
});

describe("jwt() actAs half (shipped genericJwtPreset)", () => {
  it("mints a bearer token carrying the user resolver's name and email claims", async () => {
    const preset = jwt({ secret, user: userResolver });
    const material = await preset.actAs?.({ kind: "user", subject: "host_yousef" }, grantFor("host_yousef"));
    expect(material).not.toBeNull();
    const token = material!.headers["authorization"]!.replace(/^Bearer /, "");
    const { payload } = await verifyHs256(token, secret);
    expect(payload).toMatchObject({
      sub: "host_yousef",
      name: "Yousef Helal",
      email: "yousef@host.test",
    });
  });

  it("zero user resolver mints for ANY subject (nothing can decline — doctor probe parity)", async () => {
    const preset = jwt({ secret });
    const material = await preset.actAs?.({ kind: "user", subject: "any_subject" }, grantFor("any_subject"));
    expect(material).not.toBeNull();
    const authed = new Request("https://host.test/api/vendo/doctor/act-as/echo", { headers: material!.headers });
    await expect(preset.principal(authed)).resolves.toEqual({ kind: "user", subject: "any_subject" });
  });
});

describe("jwt() oauth login redirect (authJs parity)", () => {
  it("redirects a sessionless door request to /login on the public origin carrying returnTo", async () => {
    vi.stubEnv("VENDO_BASE_URL", "https://public.example.com");
    const preset = jwt({ secret });
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
});
